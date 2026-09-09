// Pulls the previously-uploaded files for an ENROLMENT — everything the
// student and their parents/guardians have submitted — directly from the
// Jotform form(s) they came through.
//
// Why we go to Jotform directly rather than reading them off the contact in
// HubSpot: Jotform is the source of truth for the actual file URLs and the
// per-question labels (e.g. "Passport", "Medical form", "Consent letter"),
// and a HubSpot mirror would lose that context.
//
// Who sees what: a Jotform submission carries only the email the submitter
// typed, so matching that against the logged-in user's own email meant a
// parent could not see the passport their child uploaded, and the student
// could not see the consent letter their parent uploaded — each half of the
// household saw an incomplete checklist and re-uploaded documents that were
// already in. The deal is what they actually share, so the audience is every
// contact associated with the selected enrolment: we resolve that deal with
// the same logic the rest of the portal uses (_shared/deal.js), collect those
// contacts' emails, and match submissions against the whole set. A deal id
// from the browser is never trusted — resolveEnrolmentsForEmail only honours
// one that is in the logged-in contact's own associations.
//
// If the HubSpot lookup fails we fall back to the logged-in user's own email,
// so an outage degrades to the old behaviour rather than an empty tab.
//
// Inputs (querystring):
//   formIds   — comma-separated Jotform form IDs (preferred)
//   formId    — single Jotform form ID (legacy, still supported)
//   dealId    — which enrolment to scope to (validated server-side)
//   portalId / programName / programTuition — hints for picking the deal when
//               no dealId is given, same as the other enrolment endpoints
//
// Required env var: JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL (default https://api.jotform.com — set to
//                   https://eu-api.jotform.com or https://hipaa-api.jotform.com
//                   if your account is on those regions)
//
// Per-form labelling:
//   Most forms (e.g. the application form) have one named upload field per
//   document — "Passport", "Medical Form", etc. — and we use that field's
//   own label as the document name in the portal.
//
//   The free-form "document upload" form has a repeating pattern of
//   "Document Name" textbox + generic file-upload, so we use the value the
//   parent typed into that textbox as the label.
//
//   The doc-name replacement is triggered when EITHER:
//     (a) the form's ID is opted in via DOC_NAME_PATTERN_FORMS below, OR
//     (b) the upload field's own label is generic — "Additional File Upload",
//         "Upload", "File", "Attachment", "Photo Upload", etc.
//   Specific labels like "Passport" or "Medical Form" never get overridden,
//   so the application form is unaffected.
const DOC_NAME_PATTERN_FORMS = new Set([
  // Add a form ID here if it has SPECIFIC upload-field labels but you still
  // want the textbox-before-upload value to take precedence. Most forms don't
  // need this — the generic-label fallback below handles them automatically.
]);

// Returns true if a Jotform upload-field label is generic enough that we'd
// rather show the user-typed "document name" textbox value instead.
function isGenericUploadLabel(label) {
  if (!label) return true;
  const l = String(label).toLowerCase().trim();
  if (!l) return true;
  // "Additional File Upload", "File Upload", "Document Upload", "Photo Upload",
  // "Image Upload", "Attachment Upload", plain "Upload", plain "File", etc.
  if (/^(additional\s+|please\s+|new\s+|another\s+)?(file\s+|document\s+|attachment\s+|photo\s+|image\s+)?(upload|attachment|file|document)s?$/i.test(l)) {
    return true;
  }
  // "Upload (a/the/your) (file/document/photo/image/attachment)"
  if (/^upload(\s+(a|the|your))?\s+(file|document|attachment|photo|image)s?$/i.test(l)) {
    return true;
  }
  return false;
}

import { authenticate, authError } from "./_shared/auth.js";
import { proxyRef } from "./_shared/docref.js";
import {
  resolveEnrolmentsForEmail,
  fetchContactsForDeal,
  toClientEnrolment,
  hubspotHeaders
} from "./_shared/deal.js";

// Builds the email → uploader map the submission filter runs against.
// Exported for the unit tests.
//
// The logged-in user is always in the audience, even when HubSpot has nothing
// to say — their own documents must never disappear behind an API failure.
export function buildAudience(ownEmail, contacts = []) {
  const own = String(ownEmail || "").toLowerCase().trim();
  const audience = new Map();

  for (const c of contacts || []) {
    const e = String(c?.email || "").toLowerCase().trim();
    if (!e) continue;
    const name = String(c?.name || "").trim();
    audience.set(e, {
      email: e,
      name: name || null,
      label: c?.label || null,
      isSelf: e === own
    });
  }

  if (own && !audience.has(own)) {
    audience.set(own, { email: own, name: null, label: null, isSelf: true });
  }
  return audience;
}

export async function handler(event) {
  const params = event.queryStringParameters || {};
  const { formId, formIds } = params;

  try {
    // Email from the verified token — never from the request.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

    if (!process.env.JOTFORM_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Jotform is not configured",
          details: "Set JOTFORM_API_KEY in Netlify environment variables."
        })
      };
    }

    // Accept either a single formId or multiple via formIds=.
    const idList = (formIds || formId || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (idList.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing formId / formIds" }) };
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

    // Who counts as "this household": every contact on the selected deal.
    // Resolved before the Jotform calls because the audience decides which
    // submissions we keep. Both steps fail soft — see buildAudience.
    let enrolments = [];
    let selected = null;
    let contacts = [];
    if (process.env.HUBSPOT_API_KEY) {
      try {
        const headers = hubspotHeaders();
        const resolved = await resolveEnrolmentsForEmail(cleanEmail, {
          requestedDealId: params.dealId,
          program: {
            portalId: params.portalId,
            programName: params.programName,
            programTuition: params.programTuition
          },
          headers
        });
        enrolments = resolved.enrolments || [];
        selected = resolved.selected || null;
        if (selected) contacts = await fetchContactsForDeal(selected.id, headers);
      } catch (err) {
        // A HubSpot outage must not empty the tab — carry on with just the
        // logged-in user, which is exactly the pre-sharing behaviour.
        console.warn("[get-uploaded-documents] enrolment lookup failed:", err?.message || err);
      }
    }

    const audience = buildAudience(cleanEmail, contacts);

    // Process all forms in parallel — title fetch + submissions fetch each.
    const perForm = await Promise.all(idList.map(id => loadFormData(id, audience, apiKey, baseUrl)));

    // Aggregate
    const documents = [];
    const forms = [];
    let firstError = null;
    for (const r of perForm) {
      if (r.error && !firstError) firstError = r.error;
      forms.push({ id: r.id, title: r.title || null });
      for (const d of r.documents) documents.push(d);
    }

    documents.sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });

    const response = {
      documents,
      forms,
      // Context for the UI: which enrolment these documents belong to, and
      // whose uploads are pooled into the list.
      dealId: selected ? selected.id : null,
      dealName: selected ? selected.name : null,
      sharedWith: [...audience.values()].map(a => ({
        name: a.name,
        label: a.label,
        isSelf: a.isSelf
      })),
      enrolments: selected ? enrolments.map(e => toClientEnrolment(e, selected.id)) : []
    };
    if (firstError) response.warning = firstError;

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

async function loadFormData(formId, audience, apiKey, baseUrl) {
  const out = { id: formId, title: null, documents: [], error: null };

  // Fetch form metadata (for the title) and submissions in parallel.
  const [titleRes, submissions] = await Promise.all([
    fetchFormTitle(formId, apiKey, baseUrl),
    fetchAllSubmissions(formId, apiKey, baseUrl)
  ]);

  if (titleRes.error) {
    // Title is nice-to-have; don't fail the whole call over it.
    console.warn(`Form ${formId} title fetch warning:`, titleRes.error);
  } else {
    out.title = titleRes.title || null;
  }

  if (submissions.error) {
    out.error = `Form ${formId}: ${submissions.error}`;
    return out;
  }

  const isOptInForm = DOC_NAME_PATTERN_FORMS.has(String(formId));

  for (const submission of submissions.list) {
    for (const d of documentsFromSubmission(submission, audience, isOptInForm)) {
      out.documents.push(d);
    }
  }

  return out;
}

// One Jotform submission → the documents it contributes to the portal list.
// Returns [] when the submission belongs to nobody on this enrolment, or
// carries no files. Pure (no I/O) so tests/uploaded-documents.test.mjs can
// exercise the matching and attribution rules directly.
export function documentsFromSubmission(submission, audience, isOptInForm = false) {
  const out = [];
  const answers = submission?.answers || {};

  // Sort answers by `order` so we can detect a "Document Name" textbox
  // that immediately precedes a file-upload field.
  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10);
      const oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy)) return ox - oy;
      return parseInt(x.qid, 10) - parseInt(y.qid, 10);
    });

  // A form can carry more than one email field — the parent's contact
  // address and the student's, say — and which one the submitter filled in
  // varies by form. Collect them all, in order, and let the audience match
  // decide; keeping only the last one meant a submission was attributed to
  // (and filtered by) whichever field happened to come last.
  const submissionEmails = [];
  let lastTextValue = null; // last non-empty textbox/textarea answer seen
  const fileUploads = [];

  for (const a of ordered) {
    const t = String(a.type || "").toLowerCase();
    const label = a.text || a.name || "";

    if (t === "control_email" && a.answer) {
      const e = String(a.answer).toLowerCase().trim();
      if (e && !submissionEmails.includes(e)) submissionEmails.push(e);
    } else if (t === "control_textbox" || t === "control_textarea") {
      const v = a.answer;
      if (v && String(v).trim()) lastTextValue = String(v).trim();
    } else if (t === "control_fileupload" && a.answer) {
      // Decide what label to attach to this upload's documents.
      //
      // Order of preference:
      //   1. If a "Document Name" textbox came right before, use that.
      //   2. Else if the upload field has a SPECIFIC label (e.g. "Passport"),
      //      use that.
      //   3. Else (generic label like "Additional file upload" with nothing
      //      typed in the textbox), return null so the frontend can hide
      //      the heading entirely instead of showing a meaningless one.
      const generic = isGenericUploadLabel(label);
      let effectiveLabel;
      if (lastTextValue && (isOptInForm || generic)) {
        effectiveLabel = lastTextValue;
      } else if (generic) {
        effectiveLabel = null;
      } else {
        effectiveLabel = label;
      }

      const v = a.answer;
      const urls = Array.isArray(v) ? v.filter(Boolean) : [String(v)].filter(Boolean);
      for (const u of urls) {
        fileUploads.push({ url: u, fieldLabel: effectiveLabel });
      }
      // Don't carry the same textbox value over to the next file upload.
      lastTextValue = null;
    }
  }

  // Keep the submission when ANY email on it belongs to the enrolment's
  // contacts. The first match is the uploader we credit — for a form with
  // both a parent and a student email field, that is the field the form
  // asks for first, which is the person who filled it in.
  const matchedEmail = submissionEmails.find(e => audience.has(e));
  if (!matchedEmail) return out;
  if (fileUploads.length === 0) return out;

  const uploader = audience.get(matchedEmail);

  for (const f of fileUploads) {
    let filename = "Document";
    try {
      const u = new URL(f.url);
      filename = decodeURIComponent(u.pathname.split("/").pop() || "Document");
    } catch (_) { /* leave default */ }

    out.push({
      // NOTE: deliberately NOT exposing submission.id / formId here — a
      // Jotform submission ID is enough to edit the raw submission via
      // jotform.com/edit/<id>, which would bypass the secure editor.
      uploadedAt: submission.created_at || null,
      fieldLabel: f.fieldLabel,
      filename,
      // Who submitted it. `uploadedByName` is null when HubSpot had no name
      // for the contact (or the lookup failed and we're running on the
      // logged-in email alone) — the UI just omits the line in that case.
      // No email is returned; the name and the association label are all
      // the portal needs, and they are already known to the household.
      uploadedByName: uploader.name,
      uploadedByLabel: uploader.label,
      uploadedByMe: uploader.isSelf,
      // Route the file through our /document-proxy EDGE function so the
      // parent doesn't need a Jotform login to view it. We use the edge
      // function (not /.netlify/functions/get-document) because uploaded
      // documents — passport scans, medical PDFs, photos — can be larger
      // than the 6MB synchronous-function cap. The edge function streams
      // the upstream body straight through with no base64 overhead.
      url: proxyRef(f.url)
    });
  }

  return out;
}

async function fetchFormTitle(formId, apiKey, baseUrl) {
  try {
    const res = await fetch(
      `${baseUrl}/form/${encodeURIComponent(formId)}?apiKey=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { title: data?.content?.title || null };
  } catch (err) {
    return { error: err.message };
  }
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
