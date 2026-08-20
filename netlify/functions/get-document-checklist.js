// Returns the documents checklist for ONE of the logged-in student's
// enrolments, used by the Document Uploads tab on the portal.
//
// Reads a single multi-checkbox property on the Deal — internal name
// `document_submissions` by default (override with the
// DOCUMENTS_NEEDED_PROPERTY env var if HubSpot ever renames it). The
// property's master list of *options* (defined at the property level in
// HubSpot Settings) is the universe of possible required documents. The
// current value on the deal is the subset that's *still pending*.
//
// Which deal that is used to be "whichever was created most recently",
// which for a student with a College Credit add-on meant reading an empty
// property off the add-on and reporting every document as complete. Deal
// selection now comes from _shared/deal.js, and the student can switch with
// `?dealId=` — validated against their own associations.
//
// Response shape:
//   {
//     options: [<every possible document label>],
//     pending: [<docs currently listed on the deal — still needed>],
//     completed: [<options that are NOT on the deal — done>],
//     checklistState: "empty" | "partial",
//     dealId, dealName, dealKind,
//     enrolments: [...]
//   }
//
// `checklistState` exists because an empty property is ambiguous: it means
// either "everything is submitted" or "nobody has filled this in yet". The
// UI words the two cases differently rather than congratulating a student
// who has submitted nothing.
//
// We filter out the literal value "Bio complete" everywhere — it's an
// admin-only marker that shouldn't be shown to students.
//
// Required env var: HUBSPOT_API_KEY

const IGNORED_VALUES = new Set(["bio complete"]); // case-insensitive

import { authenticate, authError } from "./_shared/auth.js";
import {
  resolveEnrolmentsForEmail,
  toClientEnrolment,
  hubspotHeaders,
  DOCUMENTS_NEEDED_PROPERTY as PROPERTY_NAME
} from "./_shared/deal.js";

const EMPTY = { options: [], pending: [], completed: [], checklistState: "empty", dealId: null, enrolments: [] };

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY not configured" });
    }

    const params = event.queryStringParameters || {};
    const headers = hubspotHeaders();

    let resolved;
    try {
      resolved = await resolveEnrolmentsForEmail(identity.email, {
        requestedDealId: params.dealId,
        program: {
          portalId: params.portalId,
          programName: params.programName,
          programTuition: params.programTuition
        },
        headers
      });
    } catch (err) {
      return jsonResponse(502, { error: err.message, details: err.details });
    }

    const { enrolments, selected } = resolved;
    if (!resolved.contactId || !selected) return jsonResponse(200, EMPTY);

    // HubSpot multi-checkbox values come back as a semicolon-separated string
    // of the option *values*. Split, trim, drop empties + ignored values.
    const rawCurrent = selected.documentsNeededRaw;
    const pendingValues = rawCurrent
      .split(";")
      .map(s => s.trim())
      .filter(s => s && !IGNORED_VALUES.has(s.toLowerCase()));

    // Fetch the property definition for the master list of options, so we can
    // compute "completed" = options - pending.
    //
    // Values and labels are NOT interchangeable on this property: in the live
    // portal, value "Waiver" has label "Permissions Packet & Waiver Signed",
    // and "Medical Form (if needed)" has label "Medical History Form (If
    // needed)". Comparing the deal's stored values against option labels
    // therefore ticked off documents the student still owed AND listed the
    // same document again as pending. Match on value, display the label.
    const propRes = await fetch(
      `https://api.hubapi.com/crm/v3/properties/deals/${encodeURIComponent(PROPERTY_NAME)}`,
      { headers }
    );

    let optionDefs = [];
    if (propRes.ok) {
      const propData = await propRes.json();
      optionDefs = (propData.options || [])
        .map(o => ({
          value: String((o && o.value) ?? ""),
          label: String((o && (o.label || o.value)) ?? "")
        }))
        .filter(o => o.value || o.label)
        .filter(o => !IGNORED_VALUES.has(o.value.toLowerCase())
                  && !IGNORED_VALUES.has(o.label.toLowerCase()));
    } else {
      // Couldn't read the property definition — fall back to showing just the
      // pending list (no "completed" items rendered).
      console.warn(`[get-document-checklist] property fetch failed: ${propRes.status}`);
    }

    const labelForValue = new Map(optionDefs.map(o => [o.value.toLowerCase(), o.label]));
    const options = optionDefs.map(o => o.label);

    // Display labels, matched by value. A value with no matching option
    // definition still shows — better a raw value than a silently dropped
    // requirement.
    const pending = pendingValues.map(v => labelForValue.get(v.toLowerCase()) || v);

    const pendingValueSet = new Set(pendingValues.map(v => v.toLowerCase()));
    const completed = optionDefs
      .filter(o => !pendingValueSet.has(o.value.toLowerCase()))
      .map(o => o.label);

    return jsonResponse(200, {
      options,
      pending,
      completed,
      checklistState: rawCurrent ? "partial" : "empty",
      dealId: selected.id,
      dealName: selected.name,
      dealKind: selected.kind,
      enrolments: enrolments.map(e => toClientEnrolment(e, selected.id))
    });

  } catch (err) {
    console.error("[get-document-checklist] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error" });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
