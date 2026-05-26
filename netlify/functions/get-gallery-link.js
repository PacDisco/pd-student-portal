/**
 * GET /.netlify/functions/get-gallery-link?email=<email>&picked=<portalId>
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
  const { email, picked } = event.queryStringParameters || {};
  if (!email)  return json(400, { error: "Missing email" });

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
              `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${id}?properties=program_name,portal_title,destination`,
              { headers: hsHeaders }
            );
            const d = await r.json();
            const p = d.properties || {};
            return {
              id,
              title:       p.portal_title || p.program_name || "(untitled)",
              destination: p.destination || "",
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
    const tripProps = ["program_name", "program_start_date", "program_end_date", "destination", "portal_title"];
    const tripRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${picked_}?properties=${tripProps.join(",")}`,
      { headers: hsHeaders }
    );
    if (!tripRes.ok) return json(502, { error: "HubSpot trip lookup failed" });
    const tripData  = await tripRes.json();
    const props     = tripData.properties || {};
    const { season, year } = deriveSeasonYear(props);
    // pd-media's `program` is the natural identifier (e.g. "Bali"). HubSpot's
    // `destination` is the closest match in most setups; fall back to
    // program_name if destination is empty.
    const programName = (props.destination || props.program_name || "").trim();

    if (!season || !year || !programName) {
      return json(404, {
        error: "Trip missing date/destination metadata",
        details: { season, year, destination: programName },
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
