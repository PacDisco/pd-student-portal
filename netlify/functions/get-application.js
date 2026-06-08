// GET the logged-in user's application for the secure editor. Identity comes
// from the verified session token; the submission is resolved server-side by
// that email and its ID is never returned to the browser. Sensitive field
// values are never sent — see lib/jotform.js buildClientFields.

import { authenticate, authError } from "./_shared/auth.js";
import { findSubmissionByEmail, buildClientFields } from "./lib/jotform.js";

const json = (s, p) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }

    if (!process.env.JOTFORM_API_KEY) {
      return json(500, { error: "Jotform is not configured" });
    }

    const submission = await findSubmissionByEmail(identity.email);
    if (!submission) {
      return json(200, { found: false, fields: [] });
    }

    return json(200, {
      found: true,
      submittedAt: submission.created_at || null,
      fields: buildClientFields(submission)   // no submission ID, no sensitive values
    });
  } catch (e) {
    console.error("[get-application]", e?.message || e);
    return json(500, { error: "Could not load your application." });
  }
}
