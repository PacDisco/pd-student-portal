import { authenticate, authError } from "./_shared/auth.js";

/**
 * GET /.netlify/functions/get-gallery-link?picked=<portalId> (email from token)
 *
 * Server-side bridge between the student portal and pd-media's gallery
 * signer. Verifies that the logged-in user actually has access to the
 * requested HubSpot Portal record (same association check as portal.js),
 * reads the trip's program metadata, and asks pd-media to mint a signed
 * gallery URL.
 *
 * Returns:
 *   { url, expires_at, trip: { program_name, season, year, destination,
 *                              approved_count } }
 * or { error, code }.
 *
 * Required env vars (set on the pd-student-portal Netlify site):
 *   HUBSPOT_API_KEY    — same one portal.js uses
 *   PD_MEDIA_ORIGIN    — e.g. https://media.pacificdiscovery.org
 */

const OBJECT = "2-58411705";   // same HubSpot custom object id as portal.js

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

function seasonFromMonth(m) {
  // m is 1..12 (program_start_date month). Maps to the same buckets
  // pd-media's field_trips expects: Spring, Summer, Fall, Winter.
  if (m >= 3  && m <= 5)  return "Spring";
  if (m >= 6  && m <= 8)  return "Summer";
  if (m >= 9  && m <= 11) return "Fall";
  return "Winter";
}

function deriveSeasonYear(props) {
  // Prefer program_start_date if available, fall back to program_end_date.
  const raw = props.program_start_date || props.program_end_date;
  if (!raw) return { season: null, year: null };
  const d = new Date(raw);
  if (isNaN(d)) return { season: null, year: null };
  return { season: seasonFromMonth(d.getUTCMonth() + 1), year: d.getUTCFullYear() };
}

export async function handler(event) {
  // Email from the verified token, never the request.
  let identity;
  try { identity = await authenticate(event); } catch (e) { return authError(e); }
  const email = identity.email;
  const { picked } = event.queryStringParameters || {};

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return json(500, { error: "HUBSPOT_API_KEY env var is not set" });
  const mediaOrigin = (process.env.PD_MEDIA_ORIGIN || "").replace(/\/$/, "");
  if (!mediaOrigin) return json(500, { error: "PD_MEDIA_ORIGIN env var is not set" });

  const hsHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    // ---- 1. Look up the contact by email ----
    const contactRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST", headers: hsHeaders,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["admin_role"],
      }),
    });
    if (!contactRes.ok) return json(502, { error: "HubSpot contact lookup failed" });
    const contactData = await contactRes.json();
    const contactId   = contactData.results?.[0]?.id;
    if (!contactId) return json(404, { error: "No HubSpot contact for that email" });

    // ---- 2. Get the contact's Portal associations ----
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${OBJECT}?limit=100`,
      { headers: hsHeaders }
    );
    if (!assocRes.ok) return json(502, { error: "HubSpot associations lookup failed" });
    const assocData = await assocRes.json();
    const allowedIds = (assocData.results || []).map(r => String(r.toObjectId));
    if (!allowedIds.length) return json(404, { error: "No trips associated with this account." });

    // Caller didn't specify a portal — handle the "no picked" path:
    //   - 1 trip:    auto-select it
    //   - 2+ trips:  return a picker payload like portal.js does
    let portalId = picked ? String(picked) : null;
    if (!portalId) {
      if (allowedIds.length === 1) {
        portalId = allowedIds[0];
      } else {
        // Multi-trip picker. Fetch lightweight title/destination for each
        // associated portal so the frontend can render a chooser.
        const enriched = await Promise.all(allowedIds.map(async (id) => {
          try {
            const r = await fetch(
              `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${id}?properties=pacific_discovery_program,program_name,portal_title,destination`,
              { headers: hsHeaders }
            );
            const d = await r.json();
            const p = d.properties || {};
            return {
              id,
              title:       p.portal_title || p.program_name || p.pacific_discovery_program || "(untitled)",
              destination: p.pacific_discovery_program || p.destination || "",
            };
          } catch { return { id, title: "(unknown)", destination: "" }; }
        }));
        return json(200, { requirePicker: true, portals: enriched });
      }
    }
    if (!allowedIds.includes(portalId)) {
      return json(403, { error: "Not authorized for this trip" });
    }
    const picked_ = portalId;

    // ---- 3. Read the trip's program metadata ----
    // `pacific_discovery_program` is the canonical, exact-phrase program
    // name on the Pacific Discovery custom object (2-58411705). The same
    // field is read by Forward Business Report. The bridge passes it
    // through to pd-media unchanged — pd-media field_trips.program must
    // match this value exactly (case-insensitive, but otherwise verbatim).
    const tripProps = [
      "pacific_discovery_program",
      "program_name", "program_start_date", "program_end_date",
      "destination", "portal_title",
    ];
    const tripRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${picked_}?properties=${tripProps.join(",")}`,
      { headers: hsHeaders }
    );
    if (!tripRes.ok) return json(502, { error: "HubSpot trip lookup failed" });
    const tripData  = await tripRes.json();
    const props     = tripData.properties || {};
    const { season, year } = deriveSeasonYear(props);
    // Authoritative program name. Fall back to other fields only as a
    // last resort for legacy records that don't have it populated yet.
    const rawProgram = (
      props.pacific_discovery_program ||
      props.destination ||
      props.program_name ||
      ""
    ).trim();

    // Strip year tokens (2020-2099 etc) so "Bali 2026" matches pd-media's
    // "Bali". Also strip stray brackets and stranded punctuation so the
    // input ends up clean even when the year was wrapped in parens or
    // separated by dashes/commas.
    const programName = rawProgram
      .replace(/\b(?:19|20)\d{2}\b/g, "")            // remove 4-digit years
      .replace(/[()\[\]]/g, "")                       // strip stray brackets
      .replace(/\s+/g, " ")                            // collapse whitespace
      .replace(/^[\s\-–—,;:]+|[\s\-–—,;:]+$/g, "")   // trim stranded punctuation
      .trim();

    if (!season || !year || !programName) {
      return json(404, {
        error: "Trip missing date or program metadata",
        details: { season, year, program: programName },
        hint:   "Set Pacific Discovery Program + Program start date on this Portal record in HubSpot.",
      });
    }

    // ---- 4. Call pd-media to mint a short-lived signed gallery URL ----
    const mintRes = await fetch(`${mediaOrigin}/api/gallery-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season,
        year,
        program: programName,
        ttl_hours: 1,             // short TTL — portal re-mints each visit
      }),
    });
    const mintData = await mintRes.json();
    if (!mintRes.ok) {
      // 404 = pd-media has no field_trips row matching this season/year/program
      if (mintRes.status === 404) {
        return json(404, {
          error: "No gallery exists for this trip yet",
          hint: `Office staff must create a Field Media trip matching ${season} ${year} · ${programName}.`,
        });
      }
      return json(502, { error: mintData.error || "Gallery link mint failed" });
    }

    return json(200, {
      url:         mintData.url,
      expires_at:  mintData.expires_at,
      trip: {
        program_name:    props.program_name || null,
        portal_title:    props.portal_title || null,
        destination:     programName,
        season,
        year,
        approved_count:  mintData.trip?.approved_count ?? 0,
      },
    });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
}
