// node tests/apply-source.test.mjs
// The pd-apply adapter: applications made on apply.pacificdiscovery.org are
// merged into the Jotform reads (mirrored duplicates dropped), edits are routed
// back to pd-apply, and the photo proxy accepts pd-apply file URLs.
import assert from "node:assert/strict";

Object.assign(process.env, {
  APPLY_SERVICE_URL: "https://apply.example.org", APPLY_SERVICE_KEY: "svc",
  JOTFORM_API_KEY: "jk", SESSION_SECRET: "s".repeat(64),
});
delete process.env.HUBSPOT_API_KEY;

const PDA = "pda_11111111-2222-3333-4444-555555555555";
const calls = [];
const jot = (id, email, extra = {}) => ({ id, created_at: "2026-01-01 10:00:00", answers: { 16: { type: "control_email", text: "Participant's email", answer: email }, 27: { type: "control_textbox", text: "High School", answer: "Old High", order: "2" }, ...extra } });
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(u);
  calls.push({ host: url.host, path: url.pathname, method: init.method || "GET", headers: init.headers || {}, body: init.body });
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.host === "api.jotform.com" && url.pathname.endsWith("/submissions")) {
    return J({ content: url.pathname.includes("240277257210046") ? [jot("111", "maya@example.com"), jot("222", "leo@example.com")] : [] });
  }
  if (url.host === "apply.example.org") {
    assert.equal(init.headers["x-apply-key"], "svc");
    if (url.pathname === "/api/service/submissions") {
      if (url.searchParams.get("form") !== "240277257210046") return J({ content: [] });
      return J({ content: [{ id: PDA, jotform_id: "111", created_at: "2026-10-08 01:00:00", answers: {
        16: { type: "control_email", text: "Participant's email", answer: "maya@example.com", order: "1" },
        27: { type: "control_textbox", text: "High School you graduated from or are currently attending", answer: "Boulder High", order: "2" },
        92: { type: "control_fileupload", text: "Please upload an image of yourself", answer: ["https://apply.example.org/api/file/abc"], order: "3" },
      } }] });
    }
    if (url.pathname === `/api/service/submission/${PDA}`) {
      if ((init.method || "GET") === "POST") return J({ content: { submissionID: PDA } });
      return J({ content: { id: PDA, answers: { 27: { type: "control_textbox", text: "High School", answer: "Boulder High" } } } });
    }
  }
  return new Response("{}", { status: 404 });
};

const src = await import("../netlify/functions/_shared/apply-source.js");
const jf = await import("../netlify/functions/lib/jotform.js");
const { handler: getAppData } = await import("../netlify/functions/get-application-data.js");
const { createToken } = await import("../netlify/functions/_shared/auth.js");

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("  ✓", name); };

await t("merge drops the mirrored Jotform copy and adds the pd-apply one", async () => {
  const merged = await src.mergeApplySubmissions("240277257210046", [jot("111", "maya@example.com"), jot("222", "leo@example.com")]);
  assert.deepEqual(merged.map((s) => s.id), ["222", PDA]);
  assert.deepEqual(await src.mergeApplySubmissions("999", [jot("1", "x")]).then((l) => l.map((s) => s.id)), ["1"], "other forms untouched");
});

await t("findSubmissionByEmail returns the pd-apply application", async () => {
  const s = await jf.findSubmissionByEmail("maya@example.com");
  assert.equal(s.id, PDA);
  assert.equal((await jf.findSubmissionByEmail("leo@example.com")).id, "222");
});

await t("getSubmission / updateSubmission route pda_ ids to pd-apply", async () => {
  const s = await jf.getSubmission(PDA);
  assert.equal(s.answers[27].answer, "Boulder High");
  calls.length = 0;
  await jf.updateSubmission(PDA, { "submission[27]": "Fairview High" });
  assert.equal(calls[0].host, "apply.example.org");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].body, /submission%5B27%5D=Fairview\+High/);
});

await t("get-application-data shows the pd-apply answers, photo via the signed proxy", async () => {
  const token = createToken({ email: "maya@example.com" });
  const res = await getAppData({ queryStringParameters: {}, headers: { authorization: `Bearer ${token}`, cookie: `pd_session=${token}` } });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(body.found, true);
  assert.equal(body.submissionId, PDA);
  assert.equal(body.fields.find((f) => f.qid === "27").value, "Boulder High");
  assert.match(body.fields.find((f) => f.qid === "92").value[0], /^\/document-proxy\?ref=/);
});

await t("document proxy accepts pd-apply file URLs only on the configured host", async () => {
  assert.equal(src.isApplyFileUrl("https://apply.example.org/api/file/abc"), true);
  assert.equal(src.isApplyFileUrl("https://apply.example.org/api/service/submissions"), false);
  assert.equal(src.isApplyFileUrl("https://evil.example.org/api/file/abc"), false);
});

await t("adapter off when APPLY_SERVICE_URL is unset", async () => {
  delete process.env.APPLY_SERVICE_URL;
  assert.equal(src.applyEnabled(), false);
  assert.deepEqual((await src.mergeApplySubmissions("240277257210046", [jot("111", "a")])).map((s) => s.id), ["111"]);
});

console.log(`\n${n} passed`);
