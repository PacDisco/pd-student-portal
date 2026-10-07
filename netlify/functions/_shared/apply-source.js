// _shared/apply-source.js
//
// Reads applications from pd-apply (apply.pacificdiscovery.org) in Jotform
// submission shape and merges them into the Jotform results this portal
// already reads. That is what lets the application Jotform forms be archived:
// once pd-apply's mirror is off, new applications only exist there.
//
//   APPLY_SERVICE_URL   https://apply.pacificdiscovery.org   (unset = adapter off)
//   APPLY_SERVICE_KEY   shared secret, same value as on pd-apply
//   APPLY_FORM_IDS      Jotform form IDs pd-apply replaces
//                       (default "240277257210046,251668678208874")
//
// Nothing here throws: if pd-apply is unreachable the portal keeps working on
// Jotform data alone (a warning is logged).
//
// pd-apply submissions have ids like "pda_<uuid>". While the mirror is on the
// same application also exists in Jotform; the Jotform copy is dropped in
// favour of the pd-apply one (which carries the photo and later edits).

const CACHE_MS = 60 * 1000;
const _cache = new Map();

function cfg() {
  const url = (process.env.APPLY_SERVICE_URL || "").replace(/\/+$/, "");
  const key = process.env.APPLY_SERVICE_KEY || "";
  const forms = (process.env.APPLY_FORM_IDS || "240277257210046,251668678208874").split(",").map((s) => s.trim()).filter(Boolean);
  return { url, key, forms, on: !!(url && key) };
}

export function applyEnabled() { return cfg().on; }
export function isApplyId(id) { return /^pda_[0-9a-f-]{36}$/i.test(String(id || "")); }
export function isApplyForm(formId) { const c = cfg(); return c.on && c.forms.includes(String(formId)); }

async function call(path, init = {}) {
  const c = cfg();
  const res = await fetch(`${c.url}${path}`, { ...init, headers: { Accept: "application/json", "x-apply-key": c.key, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`pd-apply ${path.split("?")[0]} → HTTP ${res.status}`);
  return res.json();
}

/** pd-apply submissions for one Jotform form id (optionally one email). */
export async function applySubmissions(formId, { email } = {}) {
  if (!isApplyForm(formId)) return [];
  const key = `${formId}|${email || ""}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  try {
    const qs = new URLSearchParams({ form: String(formId), limit: "1000" });
    if (email) qs.set("email", String(email).toLowerCase().trim());
    const data = await call(`/api/service/submissions?${qs}`);
    const list = Array.isArray(data?.content) ? data.content : [];
    _cache.set(key, { at: Date.now(), list });
    return list;
  } catch (err) {
    console.warn("[apply-source]", err.message);
    return hit ? hit.list : [];
  }
}

/** Jotform list + pd-apply list, without the mirrored duplicates. */
export async function mergeApplySubmissions(formId, jotformList, opts = {}) {
  const extra = await applySubmissions(formId, opts);
  if (!extra.length) return jotformList || [];
  const mirrored = new Set(extra.map((s) => s.jotform_id).filter(Boolean).map(String));
  return [...(jotformList || []).filter((s) => !mirrored.has(String(s?.id))), ...extra];
}

export async function getApplySubmission(id) {
  const data = await call(`/api/service/submission/${encodeURIComponent(id)}?form=step2`);
  return data?.content || null;
}

/** params: { "submission[27]": "…", "submission[13][city]": "…" } — same as Jotform. */
export async function updateApplySubmission(id, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) body.append(k, v == null ? "" : String(v));
  _cache.clear();
  return call(`/api/service/submission/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
}

/** Is this a pd-apply file URL (the applicant photo)? */
export function isApplyFileUrl(u) {
  const c = cfg();
  if (!c.on) return false;
  try {
    const a = new URL(u); const b = new URL(c.url);
    return a.host === b.host && a.pathname.startsWith("/api/file/");
  } catch { return false; }
}
export function applyFileHeaders() { return { "x-apply-key": cfg().key }; }
