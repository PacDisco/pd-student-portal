// Builds the "Fast Facts Sheet" for a trip: one row per participant
// (Student-associated contact on the portal), with a fixed set of columns
// pulled from each student's most recent Jotform application-form submission.
// Returned as JSON; the frontend renders a preview table and offers an
// Excel (.xlsx) download built client-side with SheetJS.
//
// This is the same Jotform application form the rest of the portal already
// reads (form 240277257210046), so the column labels below are matched
// against the live form's question text.
//
// Inputs (querystring):
//   portalId — the Pacific Discovery portal (custom object) record id (required)
//   email    — the caller's email, for the server-side access check (required)
//   formId   — optional comma-separated Jotform form id override; defaults to
//              env JOTFORM_APPLICATION_FORM_ID, else "240277257210046".
//
// Required env var: HUBSPOT_API_KEY, JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL (default https://api.jotform.com)
//
// Access: identical rule to get-students.js — the caller must have a non-empty
// admin_role on their contact record. This list contains the same sensitive
// medical information as the student list, so the gate is kept in lockstep.

const OBJECT = "2-58411705";

const DEFAULT_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID
  || "240277257210046")
  .split(",").map(s => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Column spec — ordered exactly as requested. Each entry is one column in the
// output table.
//   { header }                     → match the form field whose label equals
//                                     `header` (normalised), take its value.
//   { header, label }              → same, but the form label differs from the
//                                     column header shown to instructors.
//   { header, addInfoAfter }       → the free-text "Please provide additional
//                                     information" field that immediately
//                                     follows the named parent question in the
//                                     form. These share an identical label on
//                                     the form, so they're disambiguated by
//                                     position rather than by label.
// ---------------------------------------------------------------------------
const COLUMNS = [
  { header: "Name" },
  { header: "I like to be called" },
  { header: "Participant's email" },
  { header: "Participant's mobile number" },
  { header: "Date of birth" },
  { header: "Gender" },
  { header: "Pronouns" },
  { header: "What is your passport number?" },
  { header: "What country's passport do you hold?" },
  { header: "Height (Feet & Inches)" },
  { header: "Weight (lbs)" },
  { header: "What is your swimming ability?" },
  { header: "What is your biking ability?" },
  { header: "Are you a smoker?" },
  { header: "Do you have any respiratory problems? e.g. Asthma" },
  { header: "Additional info (respiratory)", addInfoAfter: "Do you have any respiratory problems? e.g. Asthma" },
  { header: "Do you get migraines?" },
  { header: "Do you have any skin disorders?" },
  { header: "Additional info (skin)", addInfoAfter: "Do you have any skin disorders?" },
  { header: "Do you have muscular-skeletal problems?" },
  { header: "Additional info (muscular-skeletal)", addInfoAfter: "Do you have muscular-skeletal problems?" },
  { header: "Do you have Diabetes?" },
  { header: "Additional info (diabetes)", addInfoAfter: "Do you have Diabetes?" },
  { header: "Do you have Claustrophobia or get motion sickness?" },
  { header: "Additional info (claustrophobia/motion sickness)", addInfoAfter: "Do you have Claustrophobia or get motion sickness?" },
  { header: "Do you have any of the following conditions: autism, adhd, a learning disability (e.g., dyslexia, dyscalculia) or any other neurodevelopmental condition?" },
  { header: "Additional info (neurodevelopmental)", addInfoAfter: "Do you have any of the following conditions: autism, adhd, a learning disability (e.g., dyslexia, dyscalculia) or any other neurodevelopmental condition?" },
  { header: "Do you have any allergies?" },
  { header: "Additional info (allergies)", addInfoAfter: "Do you have any allergies?" },
  { header: "Do you have any dietary requirements or preferences? e.g. Gluten, Dairy, Nuts, Vegetarian, etc." },
  { header: "Additional info (dietary)", addInfoAfter: "Do you have any dietary requirements or preferences? e.g. Gluten, Dairy, Nuts, Vegetarian, etc." },
  { header: "Have you been seen by a mental health professional more than once in the past two years?" },
  { header: "Additional info (mental health)", addInfoAfter: "Have you been seen by a mental health professional more than once in the past two years?" },
  { header: "Have you ever been or are you currently being treated for substance abuse?" },
  { header: "Additional info (substance abuse)", addInfoAfter: "Have you ever been or are you currently being treated for substance abuse?" },
  { header: "Do you have any physical, psychological or chronic condition that may impact your participation in physical activities?" },
  { header: "Additional info (physical/psychological condition)", addInfoAfter: "Do you have any physical, psychological or chronic condition that may impact your participation in physical activities?" },
  { header: "Have you been hospitalized in the past three years?" },
  { header: "Additional info (hospitalized)", addInfoAfter: "Have you been hospitalized in the past three years?" },
  { header: "Is there anything else you think we should know?" },
  { header: "Please list any medications you currently take, or will be taking on program" },
  { header: "Are you fully vaccinated for Covid-19?" },
  { header: "Primary parent or guardian name" },
  { header: "Primary parent or guardian phone number" },
  { header: "Primary parent or guardian email" },
  { header: "Primary parent or guardian relationship to you" },
  { header: "Primary parent or guardian address" },
  { header: "Primary parent or guardian country" },
  { header: "Secondary parent or guardian name" },
  { header: "Secondary parent or guardian phone number" },
  { header: "Secondary parent or guardian email" },
  { header: "Secondary parent or guardian relationship to you" },
  { header: "Secondary parent or guardian address" },
  { header: "Secondary parent or guardian country" },
  { header: "Please choose your t-shirt size" }
];

import { authenticate, authError } from "./_shared/auth.js";
import { proxyRef } from "./_shared/docref.js";

export async function handler(event) {
  try {
    const { portalId, formId } = event.queryStringParameters || {};

    if (!portalId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing portalId" }) };
    }

    // Identity from the verified token; checkAdminAccess below still gates.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

    if (!process.env.HUBSPOT_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "HubSpot is not configured" }) };
    }
    if (!process.env.JOTFORM_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Jotform is not configured",
          details: "Set JOTFORM_API_KEY in Netlify environment variables."
        })
      };
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // ----- Server-side access check (same rule as get-students.js) -----
    const access = await checkAdminAccess(email, headers);
    if (!access.allowed) {
      console.warn(`[get-fast-facts] Denied for ${email} on portal ${portalId}: ${access.reason}`);
      return { statusCode: 403, body: JSON.stringify({ error: "Not authorized to view this list." }) };
    }

    // ----- 1. Resolve the trip's Student contacts -----
    const students = await fetchPortalStudents(portalId, headers);
    if (students.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          found: true,
          columns: COLUMNS.map(c => c.header),
          rows: [],
          counts: { total: 0, withSubmission: 0 },
          generatedAt: new Date().toISOString()
        })
      };
    }

    // ----- 2. Pull every application-form submission, index by email -----
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
    const targetFormIds = (formId
      ? String(formId).split(",").map(s => s.trim()).filter(Boolean)
      : DEFAULT_FORM_IDS);

    const { byEmail, warning } = await loadSubmissionsByEmail(targetFormIds, apiKey, baseUrl);

    // ----- 3. Build one row per student -----
    let withSubmission = 0;
    const rows = students.map(student => {
      const key = (student.email || "").toLowerCase().trim();
      const submission = key ? byEmail.get(key) : null;
      const cells = {};

      if (submission) {
        withSubmission++;
        const extracted = extractColumns(submission);
        for (const col of COLUMNS) cells[col.header] = extracted[col.header] ?? "";
      } else {
        for (const col of COLUMNS) cells[col.header] = "";
      }

      // If there's no submission (or the submission's name was blank), fall
      // back to the HubSpot contact name/email so the instructor still sees
      // who is missing from the form.
      if (!cells["Name"]) cells["Name"] = student.name || "";
      if (!cells["Participant's email"]) cells["Participant's email"] = student.email || "";

      // Student Bio — sourced from the HubSpot contact, not Jotform. These
      // keys live alongside the form-derived cells but are intentionally NOT
      // in COLUMNS, so they appear only on the cards (not in the column list).
      cells["Health and Dietary Information"] = student.healthAndDietary || "";
      cells["Travel and Program Motivations"] = student.travelMotivations || "";
      cells["Interview and Instructor Notes"] = student.interviewNotes || "";

      // Portrait for the ID card — pulled from the same submission we already
      // have, routed through the /document-proxy edge function so it loads in
      // the browser without a Jotform login (and isn't capped at 6MB).
      const portraitUrl = submission ? submissionPortrait(submission) : null;

      return {
        cells,
        _email: student.email || "",
        _matched: !!submission,
        _submittedAt: submission?.created_at || null,
        _portrait: portraitUrl ? proxyRef(portraitUrl) : null
      };
    });

    // Sort by participant name for a stable, readable sheet.
    rows.sort((a, b) => String(a.cells["Name"]).localeCompare(String(b.cells["Name"])));

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        formId: targetFormIds.join(","),
        columns: COLUMNS.map(c => c.header),
        rows,
        counts: { total: rows.length, withSubmission },
        generatedAt: new Date().toISOString(),
        warning: warning || null
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

// ===========================================================================
// HubSpot: resolve the Student contacts associated to a portal
// ===========================================================================
async function fetchPortalStudents(portalId, headers) {
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
    { headers }
  );
  if (!assocRes.ok) return [];

  const assocData = await assocRes.json();
  const studentIds = (assocData.results || [])
    .filter(r => r.associationTypes?.some(t => t.label === "Student"))
    .map(r => r.toObjectId);

  if (studentIds.length === 0) return [];

  const studentsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: studentIds.map(id => ({ id: String(id) })),
        properties: [
          "firstname", "lastname", "email",
          // Student Bio fields, read straight off the HubSpot contact (not
          // from Jotform). Surfaced on the "Student Bio" Fast Facts card.
          "health_and_dietary_information",
          "travel_and_program_motivations",
          "interview_and_instructor_notes"
        ]
      })
    }
  );
  if (!studentsRes.ok) return [];

  const studentsData = await studentsRes.json();
  return (studentsData.results || []).map(s => ({
    id: s.id,
    name: `${s.properties.firstname || ""} ${s.properties.lastname || ""}`.trim(),
    email: s.properties.email || "",
    // These three are HubSpot rich-text properties (stored as HTML), so strip
    // the markup down to readable plain text before it reaches the cards.
    healthAndDietary: richTextToPlain(s.properties.health_and_dietary_information),
    travelMotivations: richTextToPlain(s.properties.travel_and_program_motivations),
    interviewNotes: richTextToPlain(s.properties.interview_and_instructor_notes)
  }));
}

// ===========================================================================
// Jotform: pull all submissions across the configured form ids, keep the most
// recent submission per (lowercased) email-control answer.
// ===========================================================================
async function loadSubmissionsByEmail(formIds, apiKey, baseUrl) {
  const byEmail = new Map();
  let warning = null;

  if (!Array.isArray(formIds) || formIds.length === 0) {
    return { byEmail, warning: "No form IDs configured" };
  }

  let all = [];
  for (const formId of formIds) {
    const r = await fetchAllSubmissions(formId, apiKey, baseUrl);
    if (r.error) { if (!warning) warning = r.error; continue; }
    all.push(...r.list);
  }

  // Ascending by created_at so the last write per email wins (most recent).
  all.sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0));

  for (const submission of all) {
    const email = submissionEmail(submission);
    if (email) byEmail.set(email, submission);
  }

  return { byEmail, warning };
}

// Find the participant's uploaded portrait photo in a submission. Matches the
// same field patterns get-students.js uses ("Please upload an image of
// yourself", plus older "portrait"/"self-portrait" variants). Returns the raw
// upstream URL, or null.
const PORTRAIT_FIELD_REGEX = /(image\s+of\s+(yourself|you)|self[\s-]*portrait|profile\s+photo|head\s*shot|portrait)/i;
function submissionPortrait(submission) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k] || {};
    if (String(a.type || "").toLowerCase() !== "control_fileupload") continue;
    if (!PORTRAIT_FIELD_REGEX.test(String(a.text || a.name || ""))) continue;
    const v = a.answer;
    if (Array.isArray(v) && v.length > 0) return String(v[0]);
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function submissionEmail(submission) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k];
    if (!a) continue;
    if (String(a.type || "").toLowerCase() === "control_email" && a.answer) {
      return String(a.answer).toLowerCase().trim();
    }
  }
  return null;
}

async function fetchAllSubmissions(formId, apiKey, baseUrl) {
  const list = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text();
      return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = await res.json();
    const page = Array.isArray(data?.content) ? data.content : [];
    list.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset >= 5000) break; // safety net
  }
  return { list };
}

// ===========================================================================
// Field extraction: turn one submission into { columnHeader: value } for every
// column in COLUMNS.
// ===========================================================================
function extractColumns(submission) {
  const answers = submission?.answers || {};

  // All answered fields, sorted by their form order. `order` ties broken by qid.
  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .filter(a => (a.text || a.name))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10);
      const oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy) && ox !== oy) return ox - oy;
      return (parseInt(x.qid, 10) || 0) - (parseInt(y.qid, 10) || 0);
    });

  // Label → field. Parent question labels are unique on the form, so first
  // match wins; but if a duplicate label exists, prefer one with a value.
  const byLabel = new Map();
  ordered.forEach((f, idx) => {
    f._idx = idx;
    const key = normLabel(f.text || f.name);
    if (!key) return;
    const existing = byLabel.get(key);
    if (!existing) { byLabel.set(key, f); return; }
    if (!hasValue(existing) && hasValue(f)) byLabel.set(key, f);
  });

  const out = {};
  for (const col of COLUMNS) {
    let field = null;
    if (col.addInfoAfter) {
      field = findAdditionalInfo(ordered, byLabel, col.addInfoAfter);
    } else {
      field = byLabel.get(normLabel(col.label || col.header)) || null;
    }
    out[col.header] = field ? formatAnswer(field) : "";
  }
  return out;
}

// The "Please provide additional information" free-text box that belongs to a
// given parent question. These boxes share the same label form-wide, so we
// locate the parent and walk forward to the next additional-info field,
// stopping after a few positions.
const ADD_INFO_RE = /please provide (additional|further) information/i;
function findAdditionalInfo(ordered, byLabel, parentHeader) {
  const parent = byLabel.get(normLabel(parentHeader));
  if (!parent) return null;
  const start = parent._idx;
  for (let i = start + 1; i < ordered.length && i <= start + 3; i++) {
    const f = ordered[i];
    const label = f.text || f.name || "";
    if (ADD_INFO_RE.test(label)) return f;
  }
  return null;
}

function hasValue(field) {
  const v = formatAnswer(field);
  return v != null && v !== "";
}

// HubSpot rich-text contact properties are stored as HTML. The Fast Facts
// cards display plain text (and the renderer HTML-escapes whatever we send, so
// raw tags would show literally). Convert to readable text: turn line-break
// and block-boundary tags into spaces, drop every remaining tag, decode the
// handful of entities HubSpot emits, then collapse whitespace.
function richTextToPlain(html) {
  if (html == null) return "";
  let s = String(html);
  s = s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|blockquote)\s*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
  return s.replace(/\s+/g, " ").trim();
}

function normLabel(s) {
  return String(s == null ? "" : s)
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .replace(/\*+\s*$/, "")
    .trim()
    .toLowerCase();
}

// Mirrors get-application-data.js formatAnswer, with phone-control handling
// added (Fast Facts surfaces several phone-number columns).
function formatAnswer(a) {
  const v = a.answer;
  const t = String(a.type || "").toLowerCase();
  if (v == null) return "";

  if (t === "control_fullname" && typeof v === "object") {
    const parts = [v.first, v.middle, v.last].filter(Boolean).map(s => String(s).trim());
    return parts.join(" ").trim();
  }

  if (t === "control_phone" && typeof v === "object") {
    if (v.full) return String(v.full).trim();
    const parts = [v.area, v.phone].filter(Boolean).map(s => String(s).trim());
    return parts.join(" ").trim();
  }

  if (t === "control_datetime" && typeof v === "object") {
    const { day, month, year } = v;
    if (day && month && year) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return "";
  }

  if (t === "control_address" && typeof v === "object") {
    const parts = [v.addr_line1, v.addr_line2, v.city, v.state, v.postal, v.country]
      .filter(Boolean).map(s => String(s).trim());
    return parts.join(", ");
  }

  if (t === "control_fileupload") {
    if (Array.isArray(v)) return v.filter(Boolean).join(", ");
    return v ? String(v) : "";
  }

  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(s => String(s)).filter(Boolean).join(", ");
  if (typeof v === "object") return ""; // unknown object shape — skip rather than dump JSON
  return String(v);
}

// ===========================================================================
// Access check — identical to get-students.js: any non-empty admin_role grants
// access; everyone else is denied; fails closed on API errors.
// ===========================================================================
async function checkAdminAccess(email, headers) {
  const cleanEmail = String(email).toLowerCase().trim();
  if (!cleanEmail) return { allowed: false, reason: "Empty email" };

  let contact;
  try {
    const res = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }]
          }],
          properties: ["admin_role"]
        })
      }
    );
    if (!res.ok) return { allowed: false, reason: `Contact lookup HTTP ${res.status}` };
    const data = await res.json();
    contact = data.results?.[0];
  } catch (err) {
    return { allowed: false, reason: `Contact lookup threw: ${err.message}` };
  }
  if (!contact) return { allowed: false, reason: "Contact not found" };

  if (String(contact.properties?.admin_role || "").trim()) {
    return { allowed: true, reason: "admin_role" };
  }
  return { allowed: false, reason: "No admin_role" };
}
