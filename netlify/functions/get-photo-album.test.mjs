// Unit tests for the Google Photos parsing helpers in get-photo-album.js.
// Run with:  node netlify/functions/get-photo-album.test.mjs
//
// These cover the parsing logic only — the HubSpot/auth path needs live
// credentials and is exercised by hitting the deployed endpoint.

import assert from "node:assert/strict";
import { extractPhotos, extractTitle, isGooglePhotosLink } from "./get-photo-album.js";

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

test("rejects http (no TLS)", () => {
  assert.equal(isGooglePhotosLink("http://photos.app.goo.gl/abc"), false);
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
  assert.equal(isGooglePhotosLink("not a url"), false);
  assert.equal(isGooglePhotosLink("photos.app.goo.gl/abc"), false); // no scheme
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

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`);
