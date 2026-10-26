// POST { dealId } → { url }
// A fresh personal link to the family's acceptance page on pd-apply, where
// they can pay a payment that didn't go through, pay the rest early, or change
// the card / bank account their automatic payments use. Only for a deal that
// belongs to the logged-in user (validated like get-paid-payments).

import { authenticate, authError } from "./_shared/auth.js";
import { resolveEnrolmentsForEmail } from "./_shared/deal.js";
import { applyEnabled, applyPlanLink } from "./_shared/apply-source.js";

const json = (statusCode, payload) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let identity;
  try { identity = await authenticate(event); } catch (e) { return authError(e); }
  if (!applyEnabled()) return json(503, { error: "Payment plans aren't available right now." });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad request" }); }
  const dealId = String(body.dealId || "");
  if (!dealId) return json(400, { error: "dealId is required" });
  try {
    const resolved = await resolveEnrolmentsForEmail(identity.email, { requestedDealId: dealId });
    if (!resolved.requestHonoured || String(resolved.selected?.id) !== dealId) return json(403, { error: "That enrolment isn't yours." });
    const url = await applyPlanLink(dealId, identity.email);
    if (!url) return json(404, { error: "No payment plan for this enrolment." });
    return json(200, { url });
  } catch (err) {
    console.error("[payment-plan-link]", err.message);
    return json(502, { error: "Couldn't open your payment plan. Please try again, or email admissions@pacificdiscovery.org." });
  }
}
