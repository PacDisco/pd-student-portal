// node tests/payment-plan.test.mjs
// Payment plans from pd-apply: get-paid-payments includes the plan for the
// selected deal; payment-plan-link only opens a deal that's the user's own.
import assert from "node:assert/strict";

Object.assign(process.env, {
  APPLY_SERVICE_URL: "https://apply.example.org", APPLY_SERVICE_KEY: "svc",
  HUBSPOT_API_KEY: "hk", SESSION_SECRET: "s".repeat(64),
});

const PLAN = { plan: "monthly", planName: "Monthly payments", method: "card", remaining: 13000, needsAction: false, automatic: true, paused: false, withdrawn: false,
  next: { index: 1, due: "2026-11-26", amount: 1625, status: "scheduled" }, schedule: [{ index: 0, due: "2026-10-26", amount: 2250, status: "paid" }] };
const calls = [];
let applyDown = false;
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(u);
  calls.push({ host: url.host, path: url.pathname, search: url.search, method: init.method || "GET", headers: init.headers || {}, body: init.body });
  const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.host === "api.hubapi.com") {
    if (url.pathname === "/crm/v3/objects/contacts/search") return J({ results: [{ id: "501", properties: { email: "maya@example.com", portal_token_version: "0" } }] });
    if (url.pathname === "/crm/v4/objects/contacts/501/associations/deals") return J({ results: [{ toObjectId: 900 }] });
    if (url.pathname === "/crm/v3/objects/deals/batch/read") return J({ results: [{ id: "900", properties: { dealname: "Maya — South America", amount: "15500", pipeline: "74958084", payment_1: "250, pi_fee, 2026-10-01", payment_2: "2250, pi_dep, 2026-10-26" } }] });
    return J({ results: [] });
  }
  if (url.host === "apply.example.org") {
    assert.equal(init.headers["x-apply-key"], "svc");
    if (applyDown) return J({ error: "down" }, 502);
    if (url.pathname === "/api/service/plan") return J({ plan: url.searchParams.get("dealId") === "900" ? PLAN : null });
    if (url.pathname === "/api/service/plan-link") return J({ url: "https://apply.example.org/accept?token=abc" });
  }
  return new Response("{}", { status: 404 });
};

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const { handler: paid } = await import("../netlify/functions/get-paid-payments.js");
const { handler: link } = await import("../netlify/functions/payment-plan-link.js");
const token = createToken({ email: "maya@example.com", ver: 0 });
const ev = (extra = {}) => ({ headers: { authorization: `Bearer ${token}`, cookie: `pd_session=${token}` }, queryStringParameters: {}, ...extra });

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("  ✓", name); };

await t("get-paid-payments includes the pd-apply plan for the selected deal (asked with the user's email)", async () => {
  const res = await paid(ev());
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(body.dealId, "900");
  assert.equal(body.plan.plan, "monthly");
  const q = calls.find((c) => c.path === "/api/service/plan");
  assert.equal(new URLSearchParams(q.search).get("email"), "maya@example.com");
});

await t("pd-apply down: payments still load, just without the plan", async () => {
  applyDown = true;
  const res = await paid(ev());
  applyDown = false;
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).plan, null);
});

await t("payment-plan-link: own deal → fresh link; someone else's deal → 403; not signed in → 401", async () => {
  const ok = await link(ev({ httpMethod: "POST", body: JSON.stringify({ dealId: "900" }) }));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(JSON.parse(ok.body).url, "https://apply.example.org/accept?token=abc");
  const body = JSON.parse(calls.filter((c) => c.path === "/api/service/plan-link").at(-1).body);
  assert.deepEqual(body, { dealId: "900", email: "maya@example.com" });
  const other = await link(ev({ httpMethod: "POST", body: JSON.stringify({ dealId: "123" }) }));
  assert.equal(other.statusCode, 403);
  assert.equal((await link({ httpMethod: "POST", headers: {}, body: "{}" })).statusCode, 401);
  assert.equal((await link(ev({ httpMethod: "GET" }))).statusCode, 405);
});

console.log(`\n${n} passed`);
