// Shared session-auth for the portal's serverless functions.
//
// Tokens are stateless, HMAC-SHA256 signed with SESSION_SECRET. Payload:
//   { email, role, ver, iat, exp }
// `ver` is the contact's portal_token_version at login; logout increments that
// version server-side, which invalidates every previously-issued token for
// that contact (server-side revocation without a session store).
//
// Required env var: SESSION_SECRET (e.g. `openssl rand -hex 32`)
//                   HUBSPOT_API_KEY (for the version read/write only)

import crypto from "crypto";

// 12-hour session lifetime (was effectively unlimited — there were no tokens).
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
}

function sign(data) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not configured");
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

// ---------------------------------------------------------------------------
// Token create / verify (synchronous — signature + expiry only)
// ---------------------------------------------------------------------------
export function createToken({ email, role = "", ver = 0 } = {}) {
  const now = Date.now();
  const payload = {
    email: String(email || "").toLowerCase().trim(),
    role: role || "",
    ver: Number.isFinite(Number(ver)) ? Number(ver) : 0,
    iat: now,
    exp: now + TOKEN_TTL_MS
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") throw new Error("Missing token");
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("Malformed token");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Bad signature");
  }
  let payload;
  try { payload = JSON.parse(fromB64url(body).toString("utf8")); }
  catch { throw new Error("Bad payload"); }
  if (!payload || typeof payload !== "object") throw new Error("Bad payload");
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error("Token expired");
  return payload;
}

export function tokenFromEvent(event) {
  const h = (event && event.headers) || {};
  const raw = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Token-version lookup / bump (server-side revocation). Both FAIL OPEN: on any
// HubSpot error they behave as "unknown" (null) so an outage can't lock users
// out — a missing/erroring version check simply skips revocation.
// ---------------------------------------------------------------------------
const VERSION_CACHE_MS = 30 * 1000;
const _verCache = new Map();

export async function getCurrentTokenVersion(email) {
  const key = String(email || "").toLowerCase().trim();
  if (!key) return 0;
  const c = _verCache.get(key);
  if (c && Date.now() - c.ts < VERSION_CACHE_MS) return c.ver;
  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: key }] }],
        properties: ["email", "portal_token_version"]
      })
    });
    if (!res.ok) return null;              // unknown -> fail open
    const d = await res.json();
    const contact = d.results?.[0];
    if (!contact) return null;
    const ver = parseInt(contact.properties?.portal_token_version || "0", 10) || 0;
    _verCache.set(key, { ver, ts: Date.now() });
    return ver;
  } catch { return null; }
}

export async function bumpTokenVersion(email) {
  const key = String(email || "").toLowerCase().trim();
  if (!key) return null;
  try {
    const s = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: key }] }],
        properties: ["email", "portal_token_version"]
      })
    });
    if (!s.ok) return null;
    const contact = (await s.json()).results?.[0];
    if (!contact?.id) return null;
    const next = (parseInt(contact.properties?.portal_token_version || "0", 10) || 0) + 1;
    const p = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ properties: { portal_token_version: String(next) } })
    });
    if (!p.ok) return null;                // property may not exist -> no-op
    _verCache.set(key, { ver: next, ts: Date.now() });
    return next;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Authentication. Throws an Error with `.statusCode` (401/403) on failure so
// handlers can `try { ... } catch (e) { return authError(e); }`.
// ---------------------------------------------------------------------------
function fail(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.isAuthError = true;
  return e;
}

// Verifies the signature/expiry, rejects legacy (no `ver`) tokens, then checks
// the token's `ver` against the contact's current version (when both known).
export async function authenticate(event) {
  let payload;
  try {
    payload = verifyToken(tokenFromEvent(event));
  } catch {
    throw fail(401, "Not authenticated");
  }
  if (payload.ver === undefined || payload.ver === null) {
    throw fail(401, "Session expired, please sign in again"); // legacy token
  }
  const current = await getCurrentTokenVersion(payload.email);
  if (current !== null && Number(current) !== Number(payload.ver)) {
    throw fail(401, "Session ended, please sign in again");   // revoked
  }
  return { email: payload.email, role: String(payload.role || "").trim(), ver: payload.ver };
}

// Same as authenticate — semantic alias for per-user endpoints (the caller's
// own data). Email always comes from the token, never the request.
export async function authenticateSelf(event) {
  return authenticate(event);
}

// Requires a non-empty admin_role (embedded in the token at login).
export async function authenticateAdmin(event) {
  const identity = await authenticate(event);
  if (!identity.role) throw fail(403, "Not authorized");
  return identity;
}

// Convenience: turn an auth error into a function response.
export function authError(err) {
  const code = err && err.statusCode ? err.statusCode : 401;
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: err?.message || "Not authenticated" })
  };
}
