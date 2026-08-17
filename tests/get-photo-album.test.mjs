// Unit tests for the Google Photos parsing helpers in get-photo-album.js.
// Run with:  node tests/get-photo-album.test.mjs
//
// This file MUST stay outside netlify/functions/. Netlify treats every file in
// that directory as a deployable function, and "get-photo-album.test" is an
// illegal function name (alphanumerics, hyphens and underscores only) — it
// fails the entire build, not just that one function.
//
// These cover the parsing logic only — the HubSpot/auth path needs live
// credentials and is exercised by hitting the deployed endpoint.

import assert from "node:assert/strict";
import {
  cleanAlbumTitle,
  describeAlbumHtml,
  extractOgImage,
  findShareUrl,
  isCoverOnly,
  extractPhotos,
  extractTitle,
  isGooglePhotosLink,
  normalizeAlbumUrl,
} from "../netlify/functions/get-photo-album.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

// ---------------------------------------------------------------------------
// isGooglePhotosLink
// ---------------------------------------------------------------------------
console.log("isGooglePhotosLink");

test("accepts a photos.app.goo.gl short link", () => {
  assert.equal(isGooglePhotosLink("https://photos.app.goo.gl/aBcDeF12345"), true);
});

test("accepts a photos.google.com share link", () => {
  assert.equal(isGooglePhotosLink("https://photos.google.com/share/AF1QipAbC?key=xyz"), true);
});

test("accepts a legacy goo.gl/photos link", () => {
  assert.equal(isGooglePhotosLink("https://goo.gl/photos/abc123"), true);
});

test("rejects a non-photos goo.gl link", () => {
  assert.equal(isGooglePhotosLink("https://goo.gl/maps/abc123"), false);
});

test("rejects an arbitrary host (SSRF guard)", () => {
  assert.equal(isGooglePhotosLink("https://evil.example.com/album"), false);
  assert.equal(isGooglePhotosLink("http://169.254.169.254/latest/meta-data/"), false);
});

test("rejects a lookalike subdomain", () => {
  assert.equal(isGooglePhotosLink("https://photos.google.com.evil.test/share/x"), false);
});

test("rejects blank / garbage", () => {
  assert.equal(isGooglePhotosLink(""), false);
  assert.equal(isGooglePhotosLink(null), false);
  assert.equal(isGooglePhotosLink(undefined), false);
  assert.equal(isGooglePhotosLink("not a url"), false);
});

test("rejects a bare domain with no album path", () => {
  assert.equal(isGooglePhotosLink("https://photos.google.com"), false);
  assert.equal(isGooglePhotosLink("https://photos.google.com/"), false);
});

// ---------------------------------------------------------------------------
// normalizeAlbumUrl — HubSpot's URL field type hands back a plain string and
// is lenient about what it accepts, so these are the shapes a pasted link
// actually arrives in.
// ---------------------------------------------------------------------------
console.log("\nnormalizeAlbumUrl");

test("passes a clean https link through unchanged", () => {
  assert.equal(
    normalizeAlbumUrl("https://photos.app.goo.gl/aBcDeF12345"),
    "https://photos.app.goo.gl/aBcDeF12345"
  );
});

test("adds the scheme when HubSpot stored it without one", () => {
  assert.equal(
    normalizeAlbumUrl("photos.app.goo.gl/aBcDeF12345"),
    "https://photos.app.goo.gl/aBcDeF12345"
  );
});

test("upgrades http to https", () => {
  assert.equal(
    normalizeAlbumUrl("http://photos.app.goo.gl/aBcDeF12345"),
    "https://photos.app.goo.gl/aBcDeF12345"
  );
});

test("trims surrounding whitespace from a paste", () => {
  assert.equal(
    normalizeAlbumUrl("  https://photos.app.goo.gl/aBcDeF12345\n"),
    "https://photos.app.goo.gl/aBcDeF12345"
  );
});

test("tolerates a mixed-case host", () => {
  assert.equal(
    normalizeAlbumUrl("https://Photos.App.Goo.Gl/aBcDeF12345"),
    "https://photos.app.goo.gl/aBcDeF12345"
  );
});

test("keeps the query string (share links carry ?key=)", () => {
  assert.equal(
    normalizeAlbumUrl("https://photos.google.com/share/AF1QipAbC?key=xyz123"),
    "https://photos.google.com/share/AF1QipAbC?key=xyz123"
  );
});

test("returns null for anything off the allow-list", () => {
  assert.equal(normalizeAlbumUrl("https://evil.example.com/album"), null);
  assert.equal(normalizeAlbumUrl("evil.example.com/album"), null);       // scheme-less too
  assert.equal(normalizeAlbumUrl("javascript:alert(1)"), null);
  assert.equal(normalizeAlbumUrl("file:///etc/passwd"), null);
  assert.equal(normalizeAlbumUrl("data:text/html,<script>"), null);
});

// ---------------------------------------------------------------------------
// extractPhotos
// ---------------------------------------------------------------------------
console.log("\nextractPhotos");

// Shaped like the AF_initDataCallback payload a shared-album page ships:
// each media item is ["<baseUrl>", width, height, ...] inside a big array.
const SAMPLE = `
<!doctype html><html><head></head><body>
<script>AF_initDataCallback({key:'ds:1',data:[[
 ["AF1QipPhoto1",["https://lh3.googleusercontent.com/pw/AP1AAA_photo-one",4032,3024,null,null],1699999999],
 ["AF1QipPhoto2",["https://lh3.googleusercontent.com/pw/AP1AAA_photo-two",3024,4032,null,null],1699999998],
 ["AF1QipPhoto3",["https://lh3.googleusercontent.com/pw/AP1AAA_photo-three=w1200-h800",1200,800,null],1699999997]
]], sideChannel:{}});</script>
<script>AF_initDataCallback({key:'ds:4',data:[
 ["https://lh3.googleusercontent.com/a/ACg8ocAvatar",64,64],
 ["https://lh3.googleusercontent.com/a-/AOhSprite",32,32]
]});</script>
</body></html>`;

test("finds every media item", () => {
  const p = extractPhotos(SAMPLE);
  assert.equal(p.length, 3);
});

test("returns url, width and height", () => {
  const [first] = extractPhotos(SAMPLE);
  assert.equal(first.url, "https://lh3.googleusercontent.com/pw/AP1AAA_photo-one");
  assert.equal(first.width, 4032);
  assert.equal(first.height, 3024);
});

test("strips a pre-baked size suffix so the client can pick its own", () => {
  const p = extractPhotos(SAMPLE);
  assert.equal(p[2].url, "https://lh3.googleusercontent.com/pw/AP1AAA_photo-three");
  assert.ok(!p.some(x => x.url.includes("=")), "no photo url should carry a size directive");
});

test("excludes avatars and UI sprites", () => {
  const p = extractPhotos(SAMPLE);
  assert.ok(!p.some(x => x.url.includes("/a/")), "avatar leaked into results");
  assert.ok(!p.some(x => x.url.includes("/a-/")), "sprite leaked into results");
});

test("de-duplicates repeated urls", () => {
  const dupes = SAMPLE + SAMPLE;
  assert.equal(extractPhotos(dupes).length, 3);
});

test("preserves page order", () => {
  const p = extractPhotos(SAMPLE);
  assert.deepEqual(p.map(x => x.url.split("_").pop()), ["photo-one", "photo-two", "photo-three"]);
});

test("drops thumbnails below the 160px floor", () => {
  const tiny = `["https://lh3.googleusercontent.com/pw/AP1AAA_tiny",120,120]`;
  assert.equal(extractPhotos(tiny).length, 0);
});

test("returns an empty array for an album page with no media", () => {
  assert.deepEqual(extractPhotos("<html><body>Nothing here</body></html>"), []);
});

test("falls back to non-/pw/ media when no /pw/ items exist", () => {
  const legacy = `["https://lh3.googleusercontent.com/legacy/AAA_old-photo",1600,1200]`;
  const p = extractPhotos(legacy);
  assert.equal(p.length, 1);
  assert.equal(p[0].url, "https://lh3.googleusercontent.com/legacy/AAA_old-photo");
});

test("ignores lookalike urls on other hosts", () => {
  const evil = `["https://evil.test/lh3.googleusercontent.com/pw/AAA",1600,1200]`;
  assert.equal(extractPhotos(evil).length, 0);
});

// --- Pass 2: the loose fallback, for when Google reshapes the data blob ---
console.log("\nextractPhotos — loose fallback");

// Same media, but no adjacent width/height pair for pass 1 to latch onto.
const RESHAPED = `
<script>AF_initDataCallback({key:'ds:1',data:[
 ["AF1QipOne",{"u":"https://lh3.googleusercontent.com/pw/AP1GczAAAAAAAAAAAAAA_one","m":{}}],
 ["AF1QipTwo",{"u":"https://lh3.googleusercontent.com/pw/AP1GczBBBBBBBBBBBBBB_two","m":{}}]
]});</script>`;

test("falls back to a bare url scan when the positional match finds nothing", () => {
  const p = extractPhotos(RESHAPED);
  assert.equal(p.length, 2);
  assert.equal(p[0].url, "https://lh3.googleusercontent.com/pw/AP1GczAAAAAAAAAAAAAA_one");
});

test("fallback returns null dimensions rather than guessing", () => {
  const [first] = extractPhotos(RESHAPED);
  assert.equal(first.width, null);
  assert.equal(first.height, null);
});

test("fallback strips size suffixes and de-duplicates", () => {
  const html = `
    <meta property="og:image" content="https://lh3.googleusercontent.com/pw/AP1GczCCCCCCCCCCCCCC_cover=w468-h288-p-k">
    <div data-src="https://lh3.googleusercontent.com/pw/AP1GczCCCCCCCCCCCCCC_cover=w1000"></div>`;
  const p = extractPhotos(html);
  assert.equal(p.length, 1, "the same photo at two sizes is one photo");
  assert.equal(p[0].url, "https://lh3.googleusercontent.com/pw/AP1GczCCCCCCCCCCCCCC_cover");
});

test("fallback still excludes avatars", () => {
  const html = `https://lh3.googleusercontent.com/a/ACg8ocAvatarAvatarAvatar`;
  assert.equal(extractPhotos(html).length, 0);
});

test("the precise pass still wins when it matches", () => {
  const p = extractPhotos(SAMPLE);
  assert.equal(p[0].width, 4032, "dimensions should survive when pass 1 matched");
});

// ---------------------------------------------------------------------------
// findShareUrl — digging the real album out of a short-link interstitial.
//
// photos.app.goo.gl is a Firebase Dynamic Link: it answers 200 with an HTML
// page whose JS navigates onwards, so fetch's redirect following never fires
// and we land on a page with no photos. These are the escapings the
// destination URL shows up in.
// ---------------------------------------------------------------------------
console.log("\nfindShareUrl");

const LONG = "https://photos.google.com/share/AF1QipPC6Yli?key=SDk3MTN5";

test("finds a plain URL in markup", () => {
  assert.equal(findShareUrl(`<a href="${LONG}">continue</a>`), LONG);
});

test("finds a URL with escaped slashes inside a JS string", () => {
  const esc = `"https:\\/\\/photos.google.com\\/share\\/AF1QipPC6Yli?key=SDk3MTN5"`;
  assert.equal(findShareUrl(esc), LONG);
});

test("finds a URL with unicode-escaped separators", () => {
  const esc = `"https:\\u002F\\u002Fphotos.google.com\\u002Fshare\\u002FAF1QipPC6Yli?key\\u003dSDk3MTN5"`;
  assert.equal(findShareUrl(esc), LONG);
});

test("handles an html-escaped ampersand", () => {
  const html = `<meta http-equiv="refresh" content="0;url=${LONG}&amp;source=fdl">`;
  assert.equal(findShareUrl(html), LONG);
});

test("keeps the key parameter — the album 404s without it", () => {
  assert.ok(findShareUrl(`<a href="${LONG}">x</a>`).includes("?key="));
});

test("returns null when there's no album link to find", () => {
  assert.equal(findShareUrl("<html><body>nothing here</body></html>"), null);
  assert.equal(findShareUrl(""), null);
});

test("ignores share links on other hosts", () => {
  assert.equal(findShareUrl(`<a href="https://evil.test/photos.google.com/share/AAA">x</a>`), null);
});

// ---------------------------------------------------------------------------
// describeAlbumHtml — the staff-facing explanation of an empty album
// ---------------------------------------------------------------------------
console.log("\ndescribeAlbumHtml");

test("counts the markers that distinguish failure modes", () => {
  const d = describeAlbumHtml(SAMPLE);
  assert.equal(d.af_init_blobs, 2);
  assert.ok(d.lh3_urls >= 3);
  assert.equal(d.pw_urls, 3);
  assert.ok(d.html_bytes > 0);
});

test("reports a js-only shell as having no media at all", () => {
  const shell = "<html><body>You need JavaScript.</body></html>";
  const d = describeAlbumHtml(shell);
  assert.equal(d.lh3_urls, 0);
  assert.equal(d.pw_urls, 0);
  assert.equal(d.first_pw_context, null);
});

test("includes a bounded context window around the first media url", () => {
  const d = describeAlbumHtml(SAMPLE);
  assert.ok(typeof d.first_pw_context === "string");
  assert.ok(d.first_pw_context.length <= 320);
  assert.ok(d.first_pw_context.includes("lh3.googleusercontent.com/pw/"));
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------
console.log("\nextractTitle");

test("reads og:title (content after property)", () => {
  const h = `<meta property="og:title" content="Bali Spring 2026">`;
  assert.equal(extractTitle(h), "Bali Spring 2026");
});

test("reads og:title with the attributes reversed", () => {
  const h = `<meta content="Cambodia Summer 2026" property="og:title">`;
  assert.equal(extractTitle(h), "Cambodia Summer 2026");
});

test("ignores the generic 'Google Photos' title", () => {
  assert.equal(extractTitle(`<meta property="og:title" content="Google Photos">`), null);
});

test("returns null when there is no og:title", () => {
  assert.equal(extractTitle("<html><head></head></html>"), null);
});

// Regressions from a real album: the heading rendered as
// "Fall 2026 - New Zealand &amp; Australia · Thursday, Jul 23 📷"
test("decodes entities instead of double-escaping them", () => {
  const h = `<meta property="og:title" content="Fall 2026 - New Zealand &amp; Australia">`;
  assert.equal(extractTitle(h), "Fall 2026 - New Zealand & Australia");
});

test("strips Google's trailing date and camera emoji", () => {
  const h = `<meta property="og:title" content="Fall 2026 - New Zealand &amp; Australia · Thursday, Jul 23 📷">`;
  assert.equal(extractTitle(h), "Fall 2026 - New Zealand & Australia");
});

test("handles the date with a year, and a numeric date", () => {
  assert.equal(cleanAlbumTitle("Bali Spring 2026 · Jul 23, 2026"), "Bali Spring 2026");
  assert.equal(cleanAlbumTitle("Bali Spring 2026 · 7/23/26"), "Bali Spring 2026");
});

test("keeps a middot that is part of the album name", () => {
  assert.equal(cleanAlbumTitle("Bali · Lombok Expedition"), "Bali · Lombok Expedition");
});

test("decodes numeric and hex entities", () => {
  assert.equal(cleanAlbumTitle("Kate&#39;s trip"), "Kate's trip");
  assert.equal(cleanAlbumTitle("Kate&#x27;s trip"), "Kate's trip");
});

test("returns null for an empty or generic title", () => {
  assert.equal(cleanAlbumTitle("Google Photos"), null);
  assert.equal(cleanAlbumTitle("  "), null);
  assert.equal(cleanAlbumTitle("📷"), null);
});

// ---------------------------------------------------------------------------
// Cover-only detection — Google serves server-side fetchers a page with just
// the og:image preview. Rendering that as "1 PHOTO" tells a family the trip
// had one photo, which is worse than admitting we got nothing.
// ---------------------------------------------------------------------------
console.log("\nisCoverOnly / extractOgImage");

const COVER = "https://lh3.googleusercontent.com/pw/AP1GczCoverCoverCover";

test("reads og:image and strips its size suffix", () => {
  const h = `<meta property="og:image" content="${COVER}=w468-h288-p-k">`;
  assert.equal(extractOgImage(h), COVER);
});

test("flags a lone photo that is exactly the cover", () => {
  assert.equal(isCoverOnly([{ url: COVER }], COVER), true);
});

test("does not flag a real album that happens to include the cover", () => {
  const photos = [{ url: COVER }, { url: COVER + "2" }, { url: COVER + "3" }];
  assert.equal(isCoverOnly(photos, COVER), false);
});

test("does not flag a lone photo that isn't the cover", () => {
  assert.equal(isCoverOnly([{ url: COVER + "9" }], COVER), false);
});

test("is inert when there's no cover to compare against", () => {
  assert.equal(isCoverOnly([{ url: COVER }], null), false);
  assert.equal(isCoverOnly([], COVER), false);
});

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`);
