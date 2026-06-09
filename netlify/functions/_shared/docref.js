// Signed references for the /document-proxy.
//
// Document/photo URLs used to be passed to the browser as
//   /document-proxy?url=<raw Jotform URL>
// but Jotform file URLs embed the submission ID in their path
// (/uploads/<user>/<form>/<SUBMISSION_ID>/<file>), so the raw URL leaked the
// submission ID — enough to edit the raw submission via jotform.com/edit/<id>.
//
// Instead we hand the browser an opaque, HMAC-signed token that encodes the
// real URL. The proxy (edge function, and the Node fallback) verifies the
// signature server-side and decodes the URL — the browser never sees the
// Jotform path or the submission ID. Signed with SESSION_SECRET (same secret
// as the session tokens) so there's one secret to manage.
//
// Token format:  base64url(JSON({ u, e })) + "." + hex(HMAC_SHA256(payload))
//   u = real file URL, e = expiry epoch-ms.
// The edge function (Deno/Web Crypto) mirrors this exactly — keep the encoding
// (base64url payload, lowercase-hex signature) identical on both sides.

import crypto from "crypto";

const REF_TTL_MS = 1000 * 60 * 60 * 24; // 24h — refs are regenerated each page load

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64").toString("utf8");
}

export function signDocRef(url) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !url) return "";
  const payload = b64url(JSON.stringify({ u: String(url), e: Date.now() + REF_TTL_MS }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// Full proxy URL the browser uses. Empty string if it can't be signed (caller
// should then omit the link rather than fall back to a raw URL).
export function proxyRef(url) {
  const t = signDocRef(url);
  return t ? `/document-proxy?ref=${encodeURIComponent(t)}` : "";
}

// Node-side verify (used by the regular get-document.js fallback + tests).
// Returns the decoded URL or null.
export function verifyDocRef(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!obj || !obj.u || !obj.e || Date.now() > Number(obj.e)) return null;
  return String(obj.u);
}
