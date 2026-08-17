import { authenticate, authError } from "./_shared/auth.js";

/**
 * GET /.netlify/functions/get-photo-album?picked=<portalId>   (email from token)
 *
 * Trip photo album for the student portal. Replaces the old pd-media
 * signed-gallery bridge (get-gallery-link.js): the album is now just a
 * Google Photos shared-album URL pasted into the `photo_album_link`
 * property on the Portal custom object (2-58411705) in HubSpot.
 *
 * Access control is unchanged — the caller must be associated with the
 * Portal record they're asking about, exactly like portal.js.
 *
 * Why we read the album server-side instead of dropping a third-party
 * embed widget on the page:
 *   1. The raw share link never lands in the portal's HTML. Anyone who
 *      views source on an embed widget can lift the link, and if the
 *      album has "Collaborate" turned on they can then add photos to it.
 *      Here the link is only handed to authenticated, associated users.
 *   2. No third-party script runs on an authenticated page.
 *   3. The photos render in the portal's own markup, so they match the
 *      rest of the UI and we control the lightbox.
 *
 * Returns:
 *   { album_url, title, count, photos: [{ url, width, height }],
 *     trip: { portal_title, program_name, destination, season, year } }
 * or { requirePicker: true, portals: [...] }
 * or { error, code, hint }.
 *
 * Required env vars (on the pd-student-portal Netlify site):
 *   HUBSPOT_API_KEY   — same one portal.js uses
 *   SESSION_SECRET    — same one _shared/auth.js uses
 *
 * Unit tests for the parsing helpers live in tests/get-photo-album.test.mjs —
 * deliberately outside this directory, because Netlify tries to deploy every
 * file in netlify/functions/ as a function and rejects names containing dots.
 */

const OBJECT = "2-58411705";           // Portal custom object, same as portal.js
const ALBUM_PROP = "photo_album_link"; // HubSpot URL property (read as a string)

// Google Photos share links we accept. Anything else is rejected rather
// than fetched — this property is admin-entered, but it still shouldn't be
// able to point the server at an arbitrary host (SSRF).
const ALLOWED_HOSTS = new Set([
  "photos.app.goo.gl",
  "photos.google.com",
  "goo.gl",                            // legacy /photos/... short links
]);

// Scrape results are cached per album URL. Album pages change rarely and a
// family reloading the tab shouldn't re-fetch Google every time. The cache
// lives in the warm lambda instance only — cold starts just re-fetch.
const CACHE_TTL_MS = 10 * 60 * 1000;
const _albumCache = new Map();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Trip metadata (kept from get-gallery-link.js so the page header still reads
// "Spring 2026 · Bali" the way it did before)
// ---------------------------------------------------------------------------
function seasonFromMonth(m) {
  if (m >= 3 && m <= 5) return "Spring";
  if (m >= 6 && m <= 8) return "Summer";
  if (m >= 9 && m <= 11) return "Fall";
  return "Winter";
}

function deriveSeasonYear(props) {
  const raw = props.program_start_date || props.program_end_date;
  if (!raw) return { season: null, year: null };
  const d = new Date(raw);
  if (isNaN(d)) return { season: null, year: null };
  return { season: seasonFromMonth(d.getUTCMonth() + 1), year: d.getUTCFullYear() };
}

// ---------------------------------------------------------------------------
// Google Photos shared-album parsing
// ---------------------------------------------------------------------------

/**
 * Normalize whatever is in the HubSpot URL property into a share link we're
 * willing to fetch, or null if it isn't one.
 *
 * HubSpot's URL field type hands the value back as a plain string and is
 * lenient about what it accepts, so this tolerates the ways a link actually
 * arrives from a copy/paste: surrounding whitespace, a missing scheme
 * ("photos.app.goo.gl/abc"), an http:// scheme, and mixed-case hosts. The
 * host allow-list is the actual security boundary — it's what stops this
 * property from pointing the server at an arbitrary URL (SSRF).
 */
export function normalizeAlbumUrl(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // Scheme-less paste — HubSpot renders these as links, so treat them as URLs.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;

  let u;
  try { u = new URL(s); } catch { return null; }

  // Only web schemes, and always fetch over TLS.
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = "https:";

  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  if (host === "goo.gl" && !u.pathname.startsWith("/photos/")) return null;
  if (u.pathname === "" || u.pathname === "/") return null;   // bare domain

  return u.toString();
}

/** True if `raw` is a share link we're willing to fetch. */
export function isGooglePhotosLink(raw) {
  return normalizeAlbumUrl(raw) !== null;
}

/**
 * Pull photo URLs out of a Google Photos shared-album page.
 *
 * The album page ships its data as AF_initDataCallback(...) JS blobs rather
 * than <img> tags. Inside those blobs each media item appears as
 *   ["https://lh3.googleusercontent.com/pw/<id>", <width>, <height>, ...]
 * so a positional match on url+width+height is both simple and specific —
 * it can't accidentally match avatars or UI sprites, which aren't followed
 * by a dimension pair.
 *
 * Returns [{ url, width, height }], de-duplicated, in page order.
 */
export function extractPhotos(html) {
  const out = [];
  const seen = new Set();
  const re = /"(https:\/\/lh3\.googleusercontent\.com\/[^"\\\s]+)"\s*,\s*(\d{2,6})\s*,\s*(\d{2,6})/g;

  let m;
  while ((m = re.exec(html)) !== null) {
    // Drop any size suffix Google already baked in (=w200-h200, =s64-c, ...)
    // so the client can request whatever dimensions it needs.
    const url = m[1].split("=")[0];
    const width = parseInt(m[2], 10);
    const height = parseInt(m[3], 10);

    // Profile pictures live under /a/ or /a-/ and are square and small.
    // Real media from a shared album is served from /pw/.
    if (/\/a[-/]/.test(new URL(url).pathname)) continue;
    if (!width || !height || width < 160 || height < 160) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    out.push({ url, width, height });
  }

  // Prefer /pw/ items when we found any — that's the shared-album namespace.
  const pw = out.filter(p => p.url.includes("/pw/"));
  return pw.length ? pw : out;
}

/** Album title from the page's og:title, if present. */
export function extractTitle(html) {
  const m =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (!m) return null;
  const t = m[1].trim();
  // Google uses a generic og:title for albums with no name.
  if (!t || /^google photos$/i.test(t)) return null;
  return t;
}

async function loadAlbum(albumUrl) {
  const cached = _albumCache.get(albumUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;

  const res = await fetch(albumUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    const e = new Error(`Google Photos returned HTTP ${res.status}`);
    e.upstream = res.status;
    throw e;
  }
  const html = await res.text();

  const value = { photos: extractPhotos(html), title: extractTitle(html) };
  _albumCache.set(albumUrl, { ts: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export async function handler(event) {
  // Email always comes from the verified token, never the query string.
  let identity;
  try { identity = await authenticate(event); } catch (e) { return authError(e); }
  const email = identity.email;
  const { picked } = event.queryStringParameters || {};

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return json(500, { error: "HUBSPOT_API_KEY env var is not set" });

  const hsHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    // ---- 1. Look up the contact by email ----
    const contactRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: hsHeaders,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["admin_role"],
      }),
    });
    if (!contactRes.ok) return json(502, { error: "HubSpot contact lookup failed" });
    const contactData = await contactRes.json();
    const contactId = contactData.results?.[0]?.id;
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

    // Caller didn't specify a portal:
    //   - 1 trip:   auto-select it
    //   - 2+ trips: return a picker payload, same shape portal.js uses
    let portalId = picked ? String(picked) : null;
    if (!portalId) {
      if (allowedIds.length === 1) {
        portalId = allowedIds[0];
      } else {
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
              title: p.portal_title || p.program_name || p.pacific_discovery_program || "(untitled)",
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

    // ---- 3. Read the album link off the Portal record ----
    // Per-trip only: a blank field means "no album yet" for this trip. We
    // deliberately do NOT fall back to the global portal record, so one
    // trip's photos can never leak onto another trip's page.
    const tripProps = [
      ALBUM_PROP,
      "pacific_discovery_program", "program_name", "portal_title", "destination",
      "program_start_date", "program_end_date",
    ];
    const tripRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?properties=${tripProps.join(",")}`,
      { headers: hsHeaders }
    );
    if (tripRes.status === 400) {
      // HubSpot 400s the whole read when a requested property doesn't exist.
      return json(500, {
        error: "HubSpot rejected the property read",
        hint: `Check that the "${ALBUM_PROP}" property exists on custom object ${OBJECT}.`,
      });
    }
    if (!tripRes.ok) return json(502, { error: "HubSpot trip lookup failed" });

    const props = (await tripRes.json()).properties || {};
    const { season, year } = deriveSeasonYear(props);
    const destination = (props.pacific_discovery_program || props.destination || "")
      .replace(/\b(?:19|20)\d{2}\b/g, "")
      .replace(/[()\[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—,;:]+|[\s\-–—,;:]+$/g, "")
      .trim();

    const trip = {
      portal_title: props.portal_title || null,
      program_name: props.program_name || null,
      destination: destination || null,
      season,
      year,
    };

    const rawAlbum = String(props[ALBUM_PROP] || "").trim();
    if (!rawAlbum) {
      // An empty value is ambiguous: either nobody has pasted a link on this
      // record yet (normal), or the property doesn't exist / is misnamed on
      // this object (a setup bug). HubSpot silently ignores unknown property
      // names in a GET's ?properties= list, so both look identical from the
      // read above. Ask HubSpot which it is — this only runs on the empty
      // path, so it costs nothing in the normal case.
      let propertyExists = null;   // null = couldn't tell
      try {
        const defRes = await fetch(
          `https://api.hubapi.com/crm/v3/properties/${OBJECT}/${ALBUM_PROP}`,
          { headers: hsHeaders }
        );
        propertyExists = defRes.ok ? true : (defRes.status === 404 ? false : null);
      } catch { /* leave as null */ }

      if (propertyExists === false) {
        return json(500, {
          error: `The "${ALBUM_PROP}" property doesn't exist on object ${OBJECT}`,
          code: "PROPERTY_MISSING",
          hint: `Create a URL property with the internal name "${ALBUM_PROP}" on the Portal custom object (${OBJECT}). Note the internal name, not the label — HubSpot auto-generates it from the label and it often ends up different.`,
          portal_id: portalId,
          trip,
        });
      }

      return json(404, {
        error: "No photo album for this trip yet",
        code: "NO_ALBUM",
        hint: "Photos will appear here once the program team publishes the album.",
        // Which record was actually read. Surfaced so staff can confirm they
        // pasted the link on this Portal record and not a sibling one.
        portal_id: portalId,
        portal_url: `https://app.hubspot.com/contacts/objects/${OBJECT}/${portalId}`,
        property_checked: ALBUM_PROP,
        property_exists: propertyExists,
        trip,
      });
    }
    // Normalized once here — everything downstream (the fetch and the
    // "open in Google Photos" button) uses the cleaned https URL, so a
    // scheme-less paste in HubSpot still produces a working link.
    const albumUrl = normalizeAlbumUrl(rawAlbum);
    if (!albumUrl) {
      return json(422, {
        error: "The album link on this trip isn't a valid Google Photos link",
        code: "BAD_LINK",
        hint: `Set "${ALBUM_PROP}" on this Portal record to a Google Photos share link (photos.app.goo.gl/... or photos.google.com/share/...).`,
        trip,
      });
    }

    // ---- 4. Read the album ----
    let album;
    try {
      album = await loadAlbum(albumUrl);
    } catch (e) {
      // Google unreachable or the album was unshared/deleted. Still hand back
      // the link so the page can offer "open in Google Photos" rather than
      // showing the family a dead end.
      return json(200, {
        album_url: albumUrl,
        title: null,
        count: 0,
        photos: [],
        degraded: true,
        hint: e.upstream === 404
          ? "This album is no longer shared. Check the link sharing setting in Google Photos."
          : "Couldn't load the photos right now — you can still open the album in Google Photos.",
        trip,
      });
    }

    return json(200, {
      album_url: albumUrl,
      title: album.title,
      count: album.photos.length,
      photos: album.photos,
      degraded: album.photos.length === 0,
      hint: album.photos.length === 0
        ? "The album didn't return any photos — it may be empty, or link sharing may be turned off."
        : undefined,
      trip,
    });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
}
