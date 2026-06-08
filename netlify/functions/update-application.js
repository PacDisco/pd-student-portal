// POST changes to the logged-in user's application. Identity comes from the
// verified session token; the submission is resolved server-side by that email
// (the client never sends a submission ID). buildUpdatePayload enforces the
// rules: identity/files read-only, only whitelisted types written, address
// per-subfield, and blank sensitive fields preserved (never overwritten).

import { authenticate, authError } from "./_shared/auth.js";
import { findSubmissionByEmail, buildUpdatePayload, updateSubmission } from "./lib/jotform.js";

const json = (s, p) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }

    if (!process.env.JOTFORM_API_KEY) {
      return json(500, { error: "Jotform is not configured" });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const changes = body && body.changes;
    if (!changes || typeof changes !== "object") {
      return json(400, { error: "Missing changes" });
    }

    const submission = await findSubmissionByEmail(identity.email);
    if (!submission) {
      return json(404, { error: "No application submission found for your account." });
    }

    const { params, rejected } = buildUpdatePayload(submission, changes);
    const keys = Object.keys(params);
    if (keys.length === 0) {
      return json(200, { success: true, updated: 0, rejected });
    }

    await updateSubmission(submission.id, params);
    return json(200, { success: true, updated: keys.length, rejected });
  } catch (e) {
    console.error("[update-application]", e?.message || e);
    return json(500, { error: "Could not update your application." });
  }
}
