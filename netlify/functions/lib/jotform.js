// Server-side Jotform service for the secure application editor.
//
// Security model (why this exists instead of jotform.com/edit):
//   - The Jotform API key NEVER reaches the browser — all reads/writes go
//     through these helpers server-side.
//   - SENSITIVE fields (passport, medical, health, dietary, etc.) are never
//     sent to the client. buildClientFields returns only a `hasValue` flag.
//     On update, a blank sensitive field is PRESERVED (not overwritten), so a
//     masked value the user didn't touch can't be wiped.
//   - Email and full name are READ-ONLY (identity fields).
//   - Address is editable per whitelisted sub-field.
//   - Only a whitelist of field TYPES is writable; anything else is ignored.
//   - The submission ID is resolved server-side from the caller's token email
//     and is never exposed to the browser.
//
// Required env: JOTFORM_API_KEY. Optional: JOTFORM_BASE_URL.

// Locked to the single correct application form. Override only via env.
export const DEFAULT_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID || "240277257210046")
  .split(",").map(s => s.trim()).filter(Boolean);

function baseUrl() {
  return (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
}
function apiKey() {
  const k = process.env.JOTFORM_API_KEY;
  if (!k) throw new Error("JOTFORM_API_KEY not configured");
  return k;
}

// Field TYPES the editor is allowed to write. Structured/option fields
// (dropdown/radio/checkbox) and files are intentionally excluded to avoid
// submitting invalid values; email/fullname are read-only identity fields.
const EDITABLE_TYPES = new Set([
  "control_textbox", "control_textarea", "control_phone",
  "control_number", "control_datetime", "control_address"
]);
const READONLY_TYPES = new Set(["control_email", "control_fullname", "control_fileupload"]);
const ADDRESS_SUBFIELDS = new Set(["addr_line1", "addr_line2", "city", "state", "postal", "country"]);

// Exact sensitive labels (mirrors TRIP_LEADER_APPLICATION_FIELDS in the portal),
// plus a keyword fallback so a relabelled field still gets protected.
const SENSITIVE_LABELS = new Set([
  "Passport Number", "Country of Issue on Passport", "Expiry Date", "Passport Cover Page Photo",
  "Height", "Weight",
  "Respiratory Problems or Asthma?", "Migraines or Headaches?", "Skin Disorders?",
  "Muscular-skeletel Problems?", "Diabetes?", "Claustrophobia or Motion Sickness?",
  "Neurological problems or seizures? (i.e. autism, etc.)", "Allergic reactions to Medications?",
  "Any chronic medical conditions? (heart conditions, hearing loss, IBS, etc.)",
  "Any chronic mental health conditions? (i.e. psychosis, bipolar disorder, etc.)",
  "Have you ever had any suicidal ideation?", "Have you ever self-harmed?",
  "Do you currently take, or have been prescribed, any medications?",
  "If you answered YES to any of the above, please provide more information",
  "Have you attended a mental health practitioner, more than once, in the last 2 years?",
  "Do you suffer from anxiety, depression, ADHD or other mood disorders?",
  "Have you ever been, or are you currently being treated for substance abuse?",
  "Do you have any physical, psychological, or chronic conditions that may impact your participation in physical activities?",
  "Have you been admitted to hospital in the last 3 years?",
  "Any non-food relate allergies or illnesses?",
  "Does the student have objection to blood transfusions? (in case of medical emergency)",
  "Does the student have objection to immunisations?",
  "Are you a confident Swimmer over 50m?",
  "Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?",
  "Do you have any food allergies?"
]);
const SENSITIVE_RE = /passport|medical|health|allerg|medication|asthma|diabet|mental|suicid|self[\s-]?harm|substance|hospital|disorder|seizure|chronic|dietary|diet\b|weight|height|swim|immunis|transfusion|neurolog|migrain|respiratory|claustrophobia|psycholog|anxiety|depression/i;

function isSensitive(label) {
  const l = String(label || "").trim();
  return SENSITIVE_LABELS.has(l) || SENSITIVE_RE.test(l);
}

// --------------------------------------------------------------------------
// Jotform API calls
// --------------------------------------------------------------------------
export async function getSubmission(submissionId) {
  const url = `${baseUrl()}/submission/${encodeURIComponent(submissionId)}?apiKey=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Jotform getSubmission HTTP ${res.status}`);
  const data = await res.json();
  return data?.content || null;
}

// params: { "submission[3]": "value", "submission[5][city]": "value", ... }
export async function updateSubmission(submissionId, params) {
  const url = `${baseUrl()}/submission/${encodeURIComponent(submissionId)}?apiKey=${encodeURIComponent(apiKey())}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v == null ? "" : String(v));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString()
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Jotform updateSubmission HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Most-recent submission whose control_email answer matches `email`, across
// the configured form ids. Returns the raw submission object or null.
export async function findSubmissionByEmail(email, formIds = DEFAULT_FORM_IDS) {
  const want = String(email || "").toLowerCase().trim();
  if (!want) return null;
  let all = [];
  for (const fid of formIds) {
    let offset = 0;
    while (true) {
      const url = `${baseUrl()}/form/${encodeURIComponent(fid)}/submissions` +
        `?apiKey=${encodeURIComponent(apiKey())}&limit=1000&offset=${offset}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) break;
      const data = await res.json();
      const page = Array.isArray(data?.content) ? data.content : [];
      all.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
      if (offset >= 5000) break;
    }
  }
  const matches = all.filter(s => submissionEmail(s) === want);
  matches.sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0));
  return matches[0] || null;
}

function submissionEmail(submission) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k];
    if (a && String(a.type || "").toLowerCase() === "control_email" && a.answer) {
      return String(a.answer).toLowerCase().trim();
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Shape the submission for the browser — WITHOUT leaking sensitive values.
// --------------------------------------------------------------------------
export function buildClientFields(submission) {
  const answers = submission?.answers || {};
  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .filter(a => (a.text || a.name))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10), oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy) && ox !== oy) return ox - oy;
      return (parseInt(x.qid, 10) || 0) - (parseInt(y.qid, 10) || 0);
    });

  const out = [];
  for (const a of ordered) {
    const label = String(a.text || a.name || "").trim();
    if (!label) continue;
    const type = String(a.type || "").toLowerCase();
    const sensitive = isSensitive(label);
    const v = a.answer;

    const base = { qid: String(a.qid), label, type, sensitive };

    if (READONLY_TYPES.has(type)) {
      // Email / full name shown read-only; files surfaced as "on file" only.
      if (type === "control_fileupload") {
        out.push({ ...base, readOnly: true, kind: "file", hasValue: hasFileValue(v) });
      } else {
        out.push({ ...base, readOnly: true, kind: "text", value: sensitive ? undefined : displayValue(type, v), hasValue: hasValue(type, v) });
      }
      continue;
    }

    if (type === "control_address") {
      const addr = (v && typeof v === "object") ? v : {};
      const subs = {};
      for (const key of ADDRESS_SUBFIELDS) {
        // Address is not treated as sensitive — send current sub-values.
        subs[key] = sensitive ? undefined : String(addr[key] || "");
      }
      out.push({ ...base, kind: "address", editable: true, address: subs, hasValue: hasValue(type, v) });
      continue;
    }

    if (EDITABLE_TYPES.has(type)) {
      // Sensitive editable fields: never send the value, only hasValue.
      out.push({
        ...base,
        kind: "text",
        editable: true,
        value: sensitive ? undefined : displayValue(type, v),
        hasValue: hasValue(type, v)
      });
      continue;
    }

    // Everything else (dropdown/radio/checkbox/etc.) — display only, no value
    // if sensitive.
    out.push({ ...base, readOnly: true, kind: "text", value: sensitive ? undefined : displayValue(type, v), hasValue: hasValue(type, v) });
  }
  return out;
}

// --------------------------------------------------------------------------
// Turn the client's changes into a safe Jotform update payload.
// changes: { [qid]: string }  and for address { [qid]: { city, postal, ... } }
// Returns { params, rejected }.
// --------------------------------------------------------------------------
export function buildUpdatePayload(submission, changes) {
  const answers = submission?.answers || {};
  const params = {};
  const rejected = [];
  if (!changes || typeof changes !== "object") return { params, rejected };

  for (const [qid, raw] of Object.entries(changes)) {
    const field = answers[qid];
    if (!field) { rejected.push({ qid, reason: "unknown field" }); continue; }
    const type = String(field.type || "").toLowerCase();
    const label = String(field.text || field.name || "").trim();

    // Never writable: identity + files + non-whitelisted types.
    if (READONLY_TYPES.has(type)) { rejected.push({ qid, reason: "read-only field" }); continue; }

    if (type === "control_address") {
      if (!raw || typeof raw !== "object") { rejected.push({ qid, reason: "bad address" }); continue; }
      for (const [sub, val] of Object.entries(raw)) {
        if (!ADDRESS_SUBFIELDS.has(sub)) { rejected.push({ qid, reason: `bad address subfield ${sub}` }); continue; }
        params[`submission[${qid}][${sub}]`] = String(val == null ? "" : val);
      }
      continue;
    }

    if (!EDITABLE_TYPES.has(type)) { rejected.push({ qid, reason: `type ${type} not editable` }); continue; }

    const value = (raw == null ? "" : String(raw)).trim();

    // Preserve blank sensitive fields — never overwrite a masked value the
    // user left untouched.
    if (isSensitive(label) && value === "") { rejected.push({ qid, reason: "blank sensitive preserved" }); continue; }

    params[`submission[${qid}]`] = value;
  }
  return { params, rejected };
}

// --------------------------------------------------------------------------
// value helpers
// --------------------------------------------------------------------------
function displayValue(type, v) {
  if (v == null) return "";
  if (type === "control_datetime" && typeof v === "object") {
    const { day, month, year } = v;
    if (day && month && year) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return "";
  }
  if (type === "control_fullname" && typeof v === "object") {
    return [v.first, v.middle, v.last].filter(Boolean).map(s => String(s).trim()).join(" ").trim();
  }
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return "";
}
function hasValue(type, v) {
  if (v == null) return false;
  if (typeof v === "object") return Object.values(v).some(x => String(x || "").trim() !== "");
  return String(v).trim() !== "";
}
function hasFileValue(v) {
  if (Array.isArray(v)) return v.filter(Boolean).length > 0;
  return !!(v && String(v).trim());
}
