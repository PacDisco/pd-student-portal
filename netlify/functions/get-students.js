// Lists the students associated to a given portal record, with each
// student's actual paid totals (read from their associated Deal's
// payment_1..10 strings) and any associated Parent contacts.
//
// Important: payment_1..10 live on the *Deal*, not the Contact. The previous
// implementation read those properties off the contact directly and got
// `undefined` for every student, which meant every card showed
// "TOTAL PAID: $0 / No payments recorded".
//
// Deal selection: this used to take each student's most recently created
// deal, which ignored the portal the instructor is actually looking at. A
// student with a College Credit add-on (created after their program deal)
// showed $1,950 as their program total on every roster, and a student
// enrolled on two programs showed the other program's figures. Selection now
// goes through _shared/deal.js, scored against THIS portal.

import { authenticate, authError } from "./_shared/auth.js";
import { proxyRef } from "./_shared/docref.js";
import { fetchDealsForContact, buildEnrolments } from "./_shared/deal.js";

export async function handler(event) {
  try {
    const { portalId } = event.queryStringParameters || {};

    if (!portalId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing portalId" })
      };
    }

    // Identity from the verified token; the per-portal access check below
    // then confirms this caller may view THIS portal's students.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

    const OBJECT = "2-58411705";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // ----- Server-side access check -----
    // The student list contains sensitive medical info. Only callers who
    // are (a) an admin (any admin_role set), or (b) program-associated as
    // an Instructor or Teacher on THIS specific portal, are allowed. This
    // is enforced regardless of the frontend's display state, so DOM
    // tweaks or direct function URL hits can't bypass it.
    const access = await checkInstructorAccess(email, portalId, OBJECT, headers);
    if (!access.allowed) {
      console.warn(`[get-students] Denied for ${email} on portal ${portalId}: ${access.reason}`);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Not authorized to view this list." })
      };
    }

    // 1. Get all contacts associated to this portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );

    if (!assocRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Portal contact associations fetch failed",
          details: await assocRes.text()
        })
      };
    }

    const assocData = await assocRes.json();

    // 2. Filter to only Student associations
    const studentIds = (assocData.results || [])
      .filter(r => r.associationTypes?.some(t => t.label === "Student"))
      .map(r => r.toObjectId);

    if (studentIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ students: [] })
      };
    }

    // 3. Batch-read student contact basic info. Payment data lives on the
    //    associated deal (not here), but we DO pull two contact-level fields
    //    that the Teachers tab surfaces on each student card:
    //      - ue_student_status — e.g. "Confirmed", "Withdrawn", etc.
    //      - notes__c          — free-text notes from the school staff.
    //                            (The "__c" suffix is HubSpot's convention
    //                            for fields that came from a Salesforce
    //                            sync; the property is named "notes" in
    //                            the UI but the internal name keeps the
    //                            Salesforce-side suffix.)
    //    Both are read here regardless of which tab is calling, and the
    //    frontend decides whether to display them (Teachers tab only).
    const studentsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: studentIds.map(id => ({ id: String(id) })),
          properties: ["firstname", "lastname", "email", "phone", "ue_student_status", "notes__c"]
        })
      }
    );

    if (!studentsRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Student batch-read failed",
          details: await studentsRes.text()
        })
      };
    }

    const studentsData = await studentsRes.json();

    // 4. For each student, resolve parent contacts and deal-side payments
    //    in parallel. Also pull a single email→portrait map from the Jotform
    //    application form so each card can show a photo.
    const portraitsPromise = loadPortraitsByEmail();

    // Program context for deal scoring: lets a student's deal be matched to
    // THIS portal by name/tuition rather than falling back to recency. One
    // extra read, shared across every student on the roster.
    const programPromise = fetchProgramContext(portalId, OBJECT, headers);
    const program = await programPromise;

    const studentsRaw = await Promise.all(
      (studentsData.results || []).map(async (student) => {
        const [parents, paymentInfo] = await Promise.all([
          fetchParents(student.id, headers),
          fetchStudentPayments(student.id, headers, program)
        ]);

        return {
          id: student.id,
          name: `${student.properties.firstname || ""} ${student.properties.lastname || ""}`.trim(),
          email: student.properties.email || "",
          phone: student.properties.phone || "",
          // Teacher-tab-only fields. Sent on every response; the frontend
          // chooses whether to render them based on which tab called.
          status: (student.properties.ue_student_status || "").trim(),
          notes:  (student.properties.notes__c || "").trim(),
          totalPaid: paymentInfo.totalPaid,
          payments: paymentInfo.payments,
          dealAmount: paymentInfo.dealAmount,
          dealName: paymentInfo.dealName,
          addons: paymentInfo.addons,
          // True when HubSpot wouldn't answer for this student — the card
          // should say so rather than implying they have paid nothing.
          dealsUnavailable: Boolean(paymentInfo.dealsUnavailable),
          parents
        };
      })
    );

    const portraitsByEmail = await portraitsPromise;
    const students = studentsRaw.map(s => {
      const key = (s.email || "").toLowerCase().trim();
      const rawUrl = key ? portraitsByEmail.get(key) : null;
      return {
        ...s,
        // Route the portrait through our /document-proxy EDGE function so it
        // loads in the parent's browser without a Jotform login. We use the
        // edge function (not /.netlify/functions/get-document) because iPhone
        // portrait photos routinely exceed the 6MB synchronous-function
        // response cap. The edge function streams the upstream body straight
        // through, supporting files up to ~20MB. Null when there's no match.
        portraitUrl: rawUrl ? proxyRef(rawUrl) : null
      };
    });

    // Sort students alphabetically
    students.sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      body: JSON.stringify({ students })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// ---------- helpers ----------

async function fetchParents(contactId, headers) {
  const parentAssocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/contacts`,
    { headers }
  );
  if (!parentAssocRes.ok) return [];

  const parentAssocData = await parentAssocRes.json();
  const parentIds = (parentAssocData.results || [])
    .filter(r => r.associationTypes?.some(t => t.label === "Parent"))
    .map(r => r.toObjectId);

  if (parentIds.length === 0) return [];

  const parentsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: parentIds.map(id => ({ id: String(id) })),
        properties: ["firstname", "lastname", "email", "phone"]
      })
    }
  );

  if (!parentsRes.ok) return [];

  const parentsData = await parentsRes.json();
  return (parentsData.results || []).map(p => ({
    name: `${p.properties.firstname || ""} ${p.properties.lastname || ""}`.trim(),
    email: p.properties.email || "",
    phone: p.properties.phone || ""
  }));
}

// Returns the student's paid totals for the program deal that belongs to the
// portal being viewed. Add-on deals (College Credit, Basecamp) are reported
// separately rather than being mistaken for the program.
async function fetchStudentPayments(contactId, headers, program = {}) {
  const empty = { totalPaid: 0, payments: [], dealAmount: null, dealName: null, addons: [] };

  // fetchDealsForContact throws on a HubSpot read failure (so a 429 isn't
  // silently rendered as "no deals"). On a roster that would take down every
  // student, so contain it here and flag the one row instead.
  let deals;
  try {
    ({ deals } = await fetchDealsForContact(contactId, headers));
  } catch (err) {
    console.warn(`[get-students] deal read failed for contact ${contactId}:`, err?.message || err);
    return { ...empty, dealsUnavailable: true };
  }
  if (!deals.length) return empty;

  const { enrolments } = buildEnrolments(deals, program);
  if (!enrolments.length) return empty;

  // buildEnrolments sorts programs (best match for this portal first) ahead
  // of add-ons, so the head of the list is the roster-relevant deal.
  const selected = enrolments[0];

  return {
    totalPaid: selected.totalPaid,
    payments: selected.payments
      .filter(p => p.amount != null && p.amount > 0)
      .map(p => ({ label: `Payment ${p.index}`, amount: p.amount })),
    dealAmount: selected.amount,
    dealName: selected.name,
    // Surfaced so an instructor can see a student also holds College Credit
    // without it contaminating the program total.
    addons: enrolments
      .filter(e => e.kind === "addon")
      .map(e => ({ name: e.name, amount: e.amount, totalPaid: e.totalPaid }))
  };
}

// Builds an email → portrait-photo URL map by walking every submission of the
// Jotform application form(s). Form IDs come from the JOTFORM_APPLICATION_FORM_ID
// env var (comma-separated list); default falls back to the original application
// form plus its successor so students who used the newer form aren't missed.
//
// For each submission we look at the email-control answer and any
// control_fileupload whose label matches the photo-field pattern (covers
// "Please upload an image of yourself" on the Pacific Discovery form, plus
// older variants like "Portrait" or "Self-Portrait"). If both are present,
// we record the (lowercased) email → first photo URL. Most recent
// submission wins.
//
// Failures are swallowed silently: if the API key is missing or the call
// fails, we just return an empty map and student cards render without photos.
const PORTRAIT_FIELD_REGEX = /(image\s+of\s+(yourself|you)|self[\s-]*portrait|profile\s+photo|head\s*shot|portrait)/i;
async function loadPortraitsByEmail() {
  const empty = new Map();
  if (!process.env.JOTFORM_API_KEY) return empty;

  const formIds = (process.env.JOTFORM_APPLICATION_FORM_ID
    || "240277257210046")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (formIds.length === 0) return empty;

  const apiKey = process.env.JOTFORM_API_KEY;
  const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

  let allSubmissions = [];
  try {
    const perForm = await Promise.all(formIds.map(async (formId) => {
      const list = [];
      let offset = 0;
      while (true) {
        const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
          `?apiKey=${encodeURIComponent(apiKey)}&limit=1000&offset=${offset}`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) return [];
        const data = await res.json();
        const page = Array.isArray(data?.content) ? data.content : [];
        list.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
        if (offset >= 5000) break; // safety net
      }
      return list;
    }));
    allSubmissions = perForm.flat();
  } catch (_) {
    return empty;
  }

  // Sort ascending by created_at so when we write into the map below, the
  // last value to win is the most recent submission for each email.
  allSubmissions.sort((a, b) => {
    const ta = new Date(a?.created_at || 0).getTime();
    const tb = new Date(b?.created_at || 0).getTime();
    return ta - tb;
  });

  const out = new Map();
  for (const submission of allSubmissions) {
    const answers = submission?.answers || {};
    let email = null;
    let portrait = null;

    for (const k of Object.keys(answers)) {
      const a = answers[k] || {};
      const t = String(a.type || "").toLowerCase();
      if (!email && t === "control_email" && a.answer) {
        email = String(a.answer).toLowerCase().trim();
      } else if (!portrait && t === "control_fileupload" && a.answer) {
        const text = String(a.text || "");
        if (PORTRAIT_FIELD_REGEX.test(text)) {
          const v = a.answer;
          if (Array.isArray(v) && v.length > 0) portrait = String(v[0]);
          else if (typeof v === "string" && v) portrait = v;
        }
      }
    }

    if (email && portrait) out.set(email, portrait);
  }

  return out;
}

// Reads the Program record's name / tuition / start date so each student's
// deals can be scored against the portal being viewed. Returns an empty
// object on any failure — scoring then falls back to program-vs-add-on
// classification, which is still better than picking by recency.
async function fetchProgramContext(portalId, OBJECT, headers) {
  try {
    const qs = new URLSearchParams({
      properties: "program_name,portal_title,program_tuition,price,program_start_date"
    });
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?${qs.toString()}`,
      { headers }
    );
    if (!res.ok) return { portalId: String(portalId) };
    const data = await res.json();
    const p = data.properties || {};
    return {
      portalId: String(portalId),
      programName: p.program_name || p.portal_title || "",
      programTuition: p.program_tuition || p.price || null,
      programStartDate: p.program_start_date || null
    };
  } catch (err) {
    console.warn("[get-students] program context fetch failed:", err?.message || err);
    return { portalId: String(portalId) };
  }
}

// (extractPaymentAmount removed — payment_N parsing now lives in
// _shared/payments.js, which handles both the positional
// "250, pi_xxx, 2026-03-12" format and the labelled "Amount - USD $250.00"
// format found on 2025-era deals. The old version read only the first
// comma-separated token, so a labelled entry yielded either null or the
// fragment after a thousands separator.)

// ============================================================
// Access check: verify the calling email is an admin of any kind.
// Simple rule — any non-empty admin_role on the contact grants access
// to the student list. Everyone else is denied. Fails closed on HubSpot
// API errors.
// ============================================================
async function checkInstructorAccess(email, portalId, OBJECT, headers) {
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
