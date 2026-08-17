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
 * than <img> tags. Two passes, because the exact shape of those blobs is
 * Google's private detail and does change:
 *
 *   Pass 1 (precise) — media items appear as
 *     ["https://lh3.googleusercontent.com/pw/<id>", <width>, <height>, ...]
 *   Matching url+width+height positionally can't misfire on avatars or UI
 *   sprites, and gives us real dimensions.
 *
 *   Pass 2 (loose) — if pass 1 finds nothing, scan for bare /pw/ URLs and
 *   de-duplicate. This survives Google reordering or reshaping the array,
 *   which is the most likely way pass 1 breaks. Dimensions come back null;
 *   nothing downstream needs them (the grid crops, the lightbox scales).
 *
 * Returns [{ url, width, height }], de-duplicated, in page order.
 */
export function extractPhotos(html) {
  const out = [];
  const seen = new Set();

  const push = (rawUrl, width, height) => {
    // Drop any size suffix Google already baked in (=w200-h200, =s64-c, ...)
    // so the client can request whatever dimensions it needs.
    const url = String(rawUrl).split("=")[0];
    // Profile pictures live under /a/ or /a-/. Real shared-album media is /pw/.
    let pathname;
    try { pathname = new URL(url).pathname; } catch { return; }
    if (/^\/a[-/]/.test(pathname)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, width: width || null, height: height || null });
  };

  // ---- Pass 1: positional url + dimensions ----
  const rePositional =
    /"(https:\/\/lh3\.googleusercontent\.com\/[^"\\\s]+)"\s*,\s*(\d{2,6})\s*,\s*(\d{2,6})/g;
  let m;
  while ((m = rePositional.exec(html)) !== null) {
    const w = parseInt(m[2], 10);
    const h = parseInt(m[3], 10);
    if (!w || !h || w < 160 || h < 160) continue;   // thumbnails / icons
    push(m[1], w, h);
  }

  if (out.length) {
    // Prefer /pw/ items when we found any — that's the shared-album namespace.
    const pw = out.filter(p => p.url.includes("/pw/"));
    return pw.length ? pw : out;
  }

  // ---- Pass 2: bare /pw/ urls, any context ----
  const reBare = /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]{16,}/g;
  while ((m = reBare.exec(html)) !== null) push(m[0], null, null);

  return out;
}

/**
 * What the album page actually contained. Only used to explain a zero-photo
 * result to staff — a page that requires JavaScript and a page whose markup
 * shape changed look identical from the outside, and these counts tell them
 * apart without a redeploy.
 */
export function describeAlbumHtml(html, finalUrl) {
  const s = String(html || "");
  const count = (re) => (s.match(re) || []).length;
  const firstPw = s.indexOf("lh3.googleusercontent.com/pw/");
  const titleMatch = /<title[^>]*>([^<]{0,120})/i.exec(s);

  // Distinguish "Google served a wall" from "Google served a JS-only shell".
  // A wall means the fetch strategy is wrong and is worth fixing; a shell
  // means server-side extraction can't work at all for this album.
  const url = String(finalUrl || "");
  const wall =
    /consent\.google\.com|\/sorry\/|accounts\.google\.com/i.test(url) ||
    /Before you continue|unusual traffic|enable JavaScript and cookies|Sign in - Google/i.test(s.slice(0, 4000));

  return {
    html_bytes: s.length,
    af_init_blobs: count(/AF_initDataCallback/g),
    lh3_urls: count(/lh3\.googleusercontent\.com/g),
    pw_urls: count(/lh3\.googleusercontent\.com\/pw\//g),
    page_title: titleMatch ? titleMatch[1].trim() : null,
    final_url: url || null,
    looks_like_wall: wall,
    // A short window around the first media URL: enough to see the shape
    // Google is using now, not enough to be a data dump.
    first_pw_context: firstPw === -1 ? null : s.slice(Math.max(0, firstPw - 120), firstPw + 200),
  };
}

/**
 * Find the real album URL inside a redirect interstitial.
 *
 * photos.app.goo.gl links are Firebase Dynamic Links: they answer 200 with an
 * HTML page whose JavaScript navigates the browser onwards, rather than an
 * HTTP 3xx. `redirect: "follow"` therefore has nothing to follow, and a naive
 * fetch parses the interstitial — which contains script blobs and no photos.
 * The destination is in that page, but escaped various ways depending on
 * whether it sits in markup or inside a JS string, so unescape first.
 */
export function findShareUrl(html) {
  const s = String(html || "")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u003[dD]/g, "=")
    .replace(/\\u0026|&amp;/g, "&");
  const m = /https:\/\/photos\.google\.com\/share\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?/.exec(s);
  return m ? m[0] : null;
}

/** Decode the HTML entities that show up in meta tag content. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");   // last, so "&amp;lt;" doesn't become "<"
}

/**
 * Tidy Google's og:title into something printable.
 *
 * Google appends its own furniture to the album name — a date and a media-type
 * emoji, e.g. "Bali Spring 2026 · Thursday, Jul 23 📷". The name is everything
 * before that. Entities also arrive encoded (&amp;), and double-escaping them
 * on the way into the DOM is what produced "New Zealand &amp; Australia".
 */
export function cleanAlbumTitle(raw) {
  let t = decodeEntities(raw).trim();
  if (!t) return null;

  // Drop trailing media-type emoji / pictographs.
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").trim();

  // Drop a trailing " · <date-ish>" segment: a weekday, a month name, or a
  // bare date. Only the last segment, and only when it looks like a date —
  // album names legitimately contain middots.
  t = t.replace(
    /\s*[·•]\s*(?:(?:Mon|Tues?|Wed(?:nes)?|Thur?s?|Fri|Sat(?:ur)?|Sun)(?:day)?,?\s*)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}(?:,?\s*\d{4})?\s*$/i,
    ""
  );
  t = t.replace(/\s*[·•]\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s*[·•]\s*$/, "").trim();

  // Google uses a generic og:title for albums with no name.
  if (!t || /^google photos$/i.test(t)) return null;
  return t;
}

/** Album title from the page's og:title, if present. */
export function extractTitle(html) {
  const m =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i.exec(html);
  return m ? cleanAlbumTitle(m[1]) : null;
}

/** The album's cover image, as advertised to link-preview crawlers. */
export function extractOgImage(html) {
  const m =
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
  return m ? decodeEntities(m[1]).split("=")[0] : null;
}

/**
 * True when the only thing we managed to extract is the album cover.
 *
 * Google serves server-side fetchers a page carrying just the og:image
 * preview, not the album contents. Reporting that as "1 photo" is worse than
 * reporting nothing: the family sees a lone thumbnail — often a cover crop
 * that isn't even representative — and assumes that's the whole trip. Treat
 * it as a failed extraction so the page falls back to the widget.
 */
export function isCoverOnly(photos, ogImage) {
  if (!ogImage || photos.length !== 1) return false;
  return photos[0].url === ogImage;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      // Google shows an interstitial consent wall to clients it can't place
      // — which includes datacenter IPs like Netlify's. The wall is a real
      // HTML page (so the fetch "succeeds") but carries no album data. This
      // is the standard pre-accepted consent cookie; harmless if the album
      // page would have been served anyway.
      "Cookie": "CONSENT=YES+cb.20240101-00-p0.en+FX+000",
    },
  });
  if (!res.ok) {
    const e = new Error(`Google Photos returned HTTP ${res.status}`);
    e.upstream = res.status;
    throw e;
  }
  return { html: await res.text(), finalUrl: res.url };
}

async function loadAlbum(albumUrl) {
  const cached = _albumCache.get(albumUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;

  let { html, finalUrl } = await fetchPage(albumUrl);
  let photos = extractPhotos(html);
  let resolvedUrl = null;

  // Short links (photos.app.goo.gl) answer with a JS redirect interstitial,
  // not an HTTP 3xx — so the fetch above lands on a page with no photos in
  // it. Dig the real album URL out of that page and follow it ourselves.
  // One extra hop only: the destination is always a long share URL, and a
  // second interstitial would mean something has changed enough that we
  // should fail visibly rather than loop.
  if (!photos.length) {
    const target = findShareUrl(html);
    if (target && target !== albumUrl && target !== finalUrl) {
      resolvedUrl = target;
      ({ html, finalUrl } = await fetchPage(target));
      photos = extractPhotos(html);
    }
  }

  // A single photo that is exactly the og:image means we got the link-preview
  // cover and nothing else — i.e. extraction failed. Report it as empty so
  // the page falls back rather than showing one unrepresentative thumbnail.
  const ogImage = extractOgImage(html);
  if (isCoverOnly(photos, ogImage)) photos = [];

  const value = {
    photos,
    title: extractTitle(html),
    // Only computed when there's something to explain.
    diagnostic: photos.length
      ? null
      : { ...describeAlbumHtml(html, finalUrl), resolved_share_url: resolvedUrl },
  };
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
    // Server-side extraction is the preferred path (first-party, no external
    // script, link stays off the page). It only works if Google serves the
    // real album page to this datacenter IP rather than a consent wall.
    // When it doesn't, the page falls back to the publicalbum widget, which
    // runs in the family's browser. Set SKIP_ALBUM_SCRAPE=1 on the Netlify
    // site to stop attempting it at all and save the round trip.
    if (String(process.env.SKIP_ALBUM_SCRAPE || "") === "1") {
      return json(200, {
        album_url: albumUrl,
        title: null,
        count: 0,
        photos: [],
        degraded: true,
        skipped_scrape: true,
        trip,
      });
    }

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

    // Whether the share link is allowed to reach the browser at all.
    //
    // When we successfully extracted the photos, the portal renders them
    // itself and has no use for the link — so we withhold it. That keeps the
    // album URL out of the page source entirely: families see the photos and
    // have nothing to click through to, and nothing to forward.
    //
    // It still has to be sent when there are no photos to show, because the
    // page then falls back to the publicalbum widget (which needs data-link)
    // or to a "view the album" card, and a dead end is worse than a link.
    // Staff always get it, and EXPOSE_ALBUM_LINK=1 restores the old
    // everyone-gets-a-button behaviour if you change your mind.
    const linkAllowed =
      album.photos.length === 0 ||
      !!identity.role ||
      String(process.env.EXPOSE_ALBUM_LINK || "") === "1";

    // Staff-only. Explains a zero-photo album without needing a redeploy:
    // whether Google served us a real page, whether any media URLs were in
    // it, and what shape they're in. Never sent to families.
    const isStaff = !!identity.role;
    const diagnostic = (isStaff && album.diagnostic)
      ? { ...album.diagnostic, album_url: albumUrl }
      : undefined;

    return json(200, {
      album_url: linkAllowed ? albumUrl : undefined,
      title: album.title,
      count: album.photos.length,
      photos: album.photos,
      degraded: album.photos.length === 0,
      diagnostic,
      hint: album.photos.length === 0
        ? "The album didn't return any photos — it may be empty, or link sharing may be turned off."
        : undefined,
      trip,
    });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
}
