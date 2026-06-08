// Lists the "Program Reports" Jotform submissions that belong to one program
// (portal), so instructors can see every report filed for their trip and jump
// to Jotform to edit any of them.
//
// How submissions are tied to a program:
//   The Program Reports form (250887973978080) carries a HIDDEN field whose
//   unique name is `programId`. The portal prefills it with the program's
//   HubSpot record id (portalData.hs_object_id) when the instructor opens the
//   form. This function lists the form's submissions and keeps only those
//   whose `programId` answer matches the requested portalId — so reports stay
//   scoped to the right trip even when an instructor runs several programs.
//
// Inputs (querystring):
//   email    — caller's email, for the server-side access check (required)
//   portalId — the program (custom object) record id to scope reports to (required)
//   formId   — optional comma-separated Jotform form id override; defaults to
//              env PROGRAM_REPORTS_FORM_ID, else "250887973978080".
//
// Required env vars: HUBSPOT_API_KEY (access check), JOTFORM_API_KEY
// Optional env var:  JOTFORM_BASE_URL (default https://api.jotform.com)
//
// Access: same gate as get-instructor-files.js — any contact with a non-empty
// admin_role. Reports may contain sensitive operational detail, so non-admins
// are denied.

const DEFAULT_FORM_IDS = (process.env.PROGRAM_REPORTS_FORM_ID
  || "250887973978080")
  .split(",").map(s => s.trim()).filter(Boolean);

// Field unique-names (or label fallbacks) the form is expected to carry. These
// are prefilled by the portal; see the frontend's program_reports section.
const PROGRAM_ID_NAMES   = ["programid", "program_id", "portalid", "portal_id"];
const PROGRAM_ID_LABELS  = ["program id", "portal id"];
const EMAIL_NAMES        = ["instructoremail", "instructor_email", "email"];

// Fields used to build each row's title in the portal.
const FORM_TYPE_NAMES    = ["whattypeofformareyousubmitting", "typeofform", "formtype", "type"];
const FORM_TYPE_LABELS   = ["what type of form are you submitting", "type of form", "form type"];
const WHO_NAMES          = ["whosfillingoutthereport", "whoisfillingoutthereport", "whosfillingouttheform", "instructorname", "name"];
const WHO_LABELS         = ["whos filling out the report", "who is filling out the report", "who s filling out the report", "name"];
const WEEK_NAMES         = ["weekofprogram", "week"];
const WEEK_LABELS        = ["week of program", "week"];

import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    const { portalId, formId } = event.queryStringParameters || {};

    if (!portalId) {
      return jsonResponse(400, { error: "Missing portalId" });
    }

    // Email from the verified token; instructor/admin gate runs below.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HubSpot is not configured" });
    }
    if (!process.env.JOTFORM_API_KEY) {
      return jsonResponse(500, {
        error: "Jotform is not configured",
        details: "Set JOTFORM_API_KEY in Netlify environment variables."
      });
    }

    const hsHeaders = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // ----- Server-side access check (same rule as get-instructor-files.js) -----
    const access = await checkInstructorOrAdminAccess(email, hsHeaders);
    if (!access.allowed) {
      console.warn(`[get-program-reports] Denied for ${email} on portal ${portalId}: ${access.reason}`);
      return jsonResponse(403, { error: "Not authorized to view program reports." });
    }

    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
    const targetFormIds = (formId
      ? String(formId).split(",").map(s => s.trim()).filter(Boolean)
      : DEFAULT_FORM_IDS);

    // ----- Pull all submissions, keep those for this program -----
    let all = [];
    let warning = null;
    for (const fid of targetFormIds) {
      const r = await fetchAllSubmissions(fid, apiKey, baseUrl);
      if (r.error) { if (!warning) warning = r.error; continue; }
      all.push(...r.list);
    }

    const wantId = String(portalId).trim();
    const submissions = all
      .filter(sub => String(answerByName(sub, PROGRAM_ID_NAMES, PROGRAM_ID_LABELS) || "").trim() === wantId)
      .map(sub => {
        const id = String(sub.id || "");
        return {
          id,
          submittedAt: sub.created_at || sub.updated_at || null,
          // Title parts (composed by the portal): form type · who · week.
          formType: answerByName(sub, FORM_TYPE_NAMES, FORM_TYPE_LABELS) || "",
          submitter: answerByName(sub, WHO_NAMES, WHO_LABELS, "control_fullname") || "",
          week: answerByName(sub, WEEK_NAMES, WEEK_LABELS) || "",
          instructorEmail: answerByName(sub, EMAIL_NAMES, [], "control_email") || "",
          // Jotform's per-submission edit URL. Opens the submission in edit
          // mode; the list itself is gated to instructors/admins above.
          editUrl: id ? `https://www.jotform.com/edit/${encodeURIComponent(id)}` : ""
        };
      })
      // Newest first.
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

    return jsonResponse(200, {
      formId: targetFormIds.join(","),
      portalId: wantId,
      submissions,
      count: submissions.length,
      warning: warning || null
    });

  } catch (err) {
    console.error("[get-program-reports] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error", submissions: [] });
  }
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Find a submission answer by the field's unique name, then label, then type.
// Returns the flattened string value, or "" if not found.
function answerByName(submission, names = [], labels = [], type = null) {
  const answers = submission?.answers || {};
  // Normalise by stripping punctuation (apostrophes, "?", etc.) so label
  // matching is robust to Jotform's exact phrasing/curly quotes.
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wantNames = names.map(s => s.toLowerCase());
  const wantLabels = labels.map(norm);
  for (const k of Object.keys(answers)) {
    const a = answers[k] || {};
    const nm = String(a.name || "").toLowerCase();
    const tx = norm(a.text);
    const ty = String(a.type || "").toLowerCase();
    if (wantNames.includes(nm) || (tx && wantLabels.includes(tx)) || (type && ty === type)) {
      const v = formatAnswer(a);
      if (v) return v;
    }
  }
  return "";
}

function formatAnswer(a) {
  const v = a.answer;
  const t = String(a.type || "").toLowerCase();
  if (v == null) return "";
  if (t === "control_fullname" && typeof v === "object") {
    return [v.first, v.middle, v.last].filter(Boolean).map(s => String(s).trim()).join(" ").trim();
  }
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(s => String(s)).filter(Boolean).join(", ");
  if (typeof v === "object") return "";
  return String(v);
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
      const text = await res.text().catch(() => "");
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

// Allowed if the caller has any non-empty admin_role. Fails closed on errors.
async function checkInstructorOrAdminAccess(email, headers) {
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
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }] }],
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
