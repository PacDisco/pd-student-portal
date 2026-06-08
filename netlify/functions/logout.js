// Logout = server-side token revocation. Bumping the contact's
// portal_token_version invalidates every token issued before now (their `ver`
// no longer matches), so a token captured before logout stops working after.
// Always returns 200 so the client can clear local state regardless.

import { tokenFromEvent, verifyToken, bumpTokenVersion } from "./_shared/auth.js";

const json = (s, p) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    let p = null;
    try { p = verifyToken(tokenFromEvent(event)); } catch { p = null; }
    if (p?.email) {
      const v = await bumpTokenVersion(p.email);
      return json(200, { success: true, revoked: v !== null });
    }
    return json(200, { success: true, revoked: false });
  } catch (e) {
    console.error("[logout]", e?.message || e);
    return json(200, { success: true, revoked: false });
  }
}
