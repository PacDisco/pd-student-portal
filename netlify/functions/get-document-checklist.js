// Returns the documents checklist for a contact's most-recent associated
// Deal, used by the Document Uploads tab on the portal.
//
// Reads a single multi-checkbox property on the Deal — internal name
// `document_submissions` by default (override with the
// DOCUMENTS_NEEDED_PROPERTY env var if HubSpot ever renames it). The
// property's master list of *options* (defined at the property level in
// HubSpot Settings) is the universe of possible required documents. The
// current value on the deal is the subset that's *still pending*.
//
// Response shape:
//   {
//     options: [<every possible document label>],
//     pending: [<docs currently listed on the deal — still needed>],
//     completed: [<options that are NOT on the deal — done>],
//     dealId: "<id>" | null
//   }
//
// We filter out the literal value "Bio complete" everywhere — it's an
// admin-only marker that shouldn't be shown to students.
//
// Required env var: HUBSPOT_API_KEY
// Optional env var: DOCUMENTS_NEEDED_PROPERTY — override internal name
//                   if HubSpot uses something other than "document_submissions".

const PROPERTY_NAME = process.env.DOCUMENTS_NEEDED_PROPERTY || "document_submissions";
const IGNORED_VALUES = new Set(["bio complete"]); // case-insensitive

import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY not configured" });
    }

    const cleanEmail = identity.email;
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Find contact by email
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }]
          }]
        })
      }
    );
    if (!contactRes.ok) {
      return jsonResponse(502, {
        error: "Contact lookup failed",
        details: `HubSpot ${contactRes.status}`
      });
    }
    const contactData = await contactRes.json();
    const contactId = contactData.results?.[0]?.id;
    if (!contactId) {
      return jsonResponse(200, { options: [], pending: [], completed: [], dealId: null });
    }

    // 2. List associated deals
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
      { headers }
    );
    if (!assocRes.ok) {
      return jsonResponse(200, { options: [], pending: [], completed: [], dealId: null });
    }
    const assocData = await assocRes.json();
    const dealIds = (assocData.results || []).map(r => r.toObjectId).filter(Boolean);
    if (dealIds.length === 0) {
      return jsonResponse(200, { options: [], pending: [], completed: [], dealId: null });
    }

    // 3. Batch-read the deals to find the most-recent one + read the
    //    documents-needed property's current value on it.
    const dealsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: dealIds.map(id => ({ id: String(id) })),
          properties: ["createdate", PROPERTY_NAME]
        })
      }
    );
    if (!dealsRes.ok) {
      return jsonResponse(502, {
        error: "Deal batch-read failed",
        details: `HubSpot ${dealsRes.status}`
      });
    }
    const dealsData = await dealsRes.json();
    const deals = (dealsData.results || []).slice().sort((a, b) => {
      const ta = new Date(a.properties?.createdate || 0).getTime();
      const tb = new Date(b.properties?.createdate || 0).getTime();
      return tb - ta;
    });
    const deal = deals[0];

    // HubSpot multi-checkbox values come back as a semicolon-separated
    // string. Split, trim, drop empties + ignored values.
    const rawCurrent = (deal?.properties?.[PROPERTY_NAME] || "").trim();
    const pending = rawCurrent
      .split(";")
      .map(s => s.trim())
      .filter(s => s && !IGNORED_VALUES.has(s.toLowerCase()));

    // 4. Fetch the property definition to get the master list of options
    //    so we can compute "completed" = options - pending.
    const propRes = await fetch(
      `https://api.hubapi.com/crm/v3/properties/deals/${encodeURIComponent(PROPERTY_NAME)}`,
      { headers }
    );

    let options = [];
    if (propRes.ok) {
      const propData = await propRes.json();
      options = (propData.options || [])
        .map(o => (o && (o.label || o.value)) || "")
        .filter(Boolean)
        .filter(v => !IGNORED_VALUES.has(v.toLowerCase()));
    } else {
      // Couldn't read the property definition — fall back to showing
      // just the pending list (no "completed" items rendered).
      console.warn(`[get-document-checklist] property fetch failed: ${propRes.status}`);
    }

    // Set-based diff so we don't depend on exact array order.
    const pendingSet = new Set(pending.map(v => v.toLowerCase()));
    const completed = options.filter(o => !pendingSet.has(o.toLowerCase()));

    return jsonResponse(200, {
      options,
      pending,
      completed,
      dealId: deal?.id || null
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
