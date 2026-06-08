import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    // Identity from the verified session token, never the request.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

    const params = event.queryStringParameters || {};
    // Admin viewing path: caller passed ?portalId=… to view a specific trip,
    // bypassing the contact-association gate. Requires an admin role (the
    // role is embedded in the verified token), checked immediately below.
    const adminPortalId = params.portalId;
    // Leader / multi-trip user picker: caller passes ?picked=<id> after
    // choosing one of their associated trips on /my-trips.html. We verify the
    // picked id is actually in the user's association list before honouring it.
    const pickedPortalId = params.picked;

    if (adminPortalId && !identity.role) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Not authorized to view this trip." })
      };
    }

    const OBJECT = "2-58411705";
    // The "global" Portal record holds shared default content (insurance,
    // FAQs, payment form URL, document upload form, etc.). Any property
    // that's empty on a trip's record falls back to whatever is set here.
    const GLOBAL_PORTAL_ID = "54796059552";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Manual overrides for paired labels where HubSpot returns null
    // Add new paired labels here as needed: typeId -> label name
    // NOTE: typeId 28 was the Unearthed object's "Trip Leader" pairing.
    // The new Pacific Discovery custom object (2-58411705) likely uses a
    // different typeId for the "Instructor" pairing — check HubSpot if
    // the override doesn't seem to be firing for instructors.
    const pairedLabelOverrides = {
      28: "Instructor"
    };

    // ----- Resolve portalId + tab-visibility labels -----
    // Two paths:
    //   (A) Regular user: look up the contact, find their portal association,
    //       use the typeIds to figure out which tabs they should see.
    //   (B) Admin viewing: caller already told us which portal to load, so
    //       skip both lookups. Admins see every tab — return all labels.
    let portalId, labels;
    // Populated only on the email-auth path. Used after the if/else so
    // the response can include availableTripCount for the "Switch trip"
    // header link.
    let associatedPortalIds = null;

    if (adminPortalId) {
      portalId = String(adminPortalId);
      // Returning every plausible label so applyVisibility() in the
      // frontend keeps every tab on for admin viewing.
      labels = ["Parent", "Student", "Teacher", "Instructor"];
    } else {
      // Path A: contact-association lookup. Also pull admin_role so the
      // instructor-content access gate below can check it.
      const contactRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filterGroups: [{
              filters: [{
                propertyName: "email",
                operator: "EQ",
                value: email
              }]
            }],
            properties: ["admin_role"]
          })
        }
      );

      if (!contactRes.ok) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Contact fetch failed",
            details: await contactRes.text()
          })
        };
      }

      const contactData = await contactRes.json();
      const contactId = contactData.results?.[0]?.id;
      // Capture admin_role for the instructor-content access gate (see
      // the strip block further down). Empty string when not set.
      var callerAdminRole = String(contactData.results?.[0]?.properties?.admin_role || "").trim();

      console.log("CONTACT ID:", contactId);

      if (!contactId) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "Contact not found" })
        };
      }

      // 2. Get associated portal
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${OBJECT}`,
        { headers }
      );

      if (!assocRes.ok) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Association fetch failed",
            details: await assocRes.text()
          })
        };
      }

      const assocData = await assocRes.json();

      console.log("RAW ASSOC RESULTS:", JSON.stringify(assocData.results, null, 2));

      if (!assocData.results || assocData.results.length === 0) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "No portal association found" })
        };
      }

      // Build the list of all portals this contact is associated with.
      // We need it in two places: to detect the "multi-trip" case below,
      // and to verify a `?picked=` param really belongs to this user.
      associatedPortalIds = assocData.results
        .map(r => String(r.toObjectId))
        .filter(Boolean);

      if (associatedPortalIds.length > 1) {
        // Multi-trip user (e.g. an expedition leader running 2 trips).
        // If they\'ve picked one already, verify it belongs to them and
        // use it. Otherwise return a "requirePicker" payload that the
        // frontend uses to bounce them to /my-trips.html.
        if (pickedPortalId && associatedPortalIds.includes(String(pickedPortalId))) {
          portalId = String(pickedPortalId);
        } else {
          // Fetch lightweight metadata for each associated portal so the
          // picker page can render trip cards without a second round-trip.
          const portalCards = await fetchPortalCards(associatedPortalIds, OBJECT, headers);
          return {
            statusCode: 200,
            body: JSON.stringify({
              requirePicker: true,
              portals: portalCards
            })
          };
        }
      } else {
        portalId = associatedPortalIds[0];
      }

      console.log("PORTAL ID:", portalId);

      // Get typeIds from this association
      const typeIds = assocData.results
        .flatMap(r => r.associationTypes || [])
        .map(t => t.typeId);

      // Fetch label definitions
      const labelDefsRes = await fetch(
        `https://api.hubapi.com/crm/v4/associations/contacts/${OBJECT}/labels`,
        { headers }
      );

      const labelDefs = await labelDefsRes.json();

      console.log("LABEL DEFS:", JSON.stringify(labelDefs, null, 2));

      // Match typeIds to label definitions
      // Use override map for paired labels where HubSpot returns null
      labels = (labelDefs.results || [])
        .filter(def => typeIds.includes(def.typeId))
        .map(def => pairedLabelOverrides[def.typeId] || def.label)
        .filter(l => l && l !== "Program");

      console.log("LABELS EXTRACTED:", labels);
    }

    // 3. Get portal content from BOTH the trip's record AND the global
    //    record in parallel, then merge with trip-priority. Any property
    //    that's empty (or null/undefined) on the trip record gets filled
    //    in from the global record's value. This way you can set defaults
    //    once on the global record and override per-trip whenever needed,
    //    for ANY property in the list below — no per-field special casing
    //    required in the frontend.
    //
    // ============================================================
    // === EDIT THIS LINE TO ADD A NEW PROPERTY ===
    // To make a new HubSpot property visible to the portal, append its
    // internal name to the comma-separated list below. See
    // HOW_TO_ADD_FIELDS.md in the project root for a step-by-step guide.
    // ============================================================
    const PORTAL_PROPERTIES = [
      // Core program metadata (new schema)
      "program_name", "program_start_date", "program_end_date", "program_tuition",
      // Legacy program metadata — kept for graceful fallback on records
      // that haven't been migrated to the new schema yet.
      "portal_title", "destination", "price",
      // Tab content (rich text)
      "trip_information_content", "destination_overview_content",
      "travel_information_content", "general_information_content",
      "family_information_content", "payments_information_content",
      "trip_leader_information_content", "teacher_information_content",
      "faqs", "hs_object_id",
      // Payment form URLs
      "payments_form_url", "payment_form_url",
      // Schedule / itinerary (program_itinerary is the new field; itinerary
      // is the legacy one kept for fallback).
      "program_itinerary", "itinerary",
      // Expedition Overview cards (new schema): Information Sessions +
      // Pre-Departure Webinar. Each has a date and 2 URL fields (live link +
      // recording). The live link auto-hides in the UI once the date passes.
      "information_session", "information_sessions_meeting_link", "information_session_recording",
      "predeparture_webinar_date", "predeparture_webinar_link", "predeparture_webinar_recording",
      // Visas, Flights & Insurance tab — three rich-text content fields.
      "visa_information", "flight_information", "insurance_information",
      // Manuals tab — rich-text "Resources" block below the 3 URL cards.
      // Try several common property names so this works regardless of
      // what the Program object actually calls it. If your HubSpot uses
      // a different name, add it to this list.
      "resources", "resources_content", "student_resources", "manuals_resources",
      // Legacy schedule fields — still fetched for fallback in case the
      // record references them elsewhere; the old overview cards that used
      // them have been removed from the UI.
      "initial_planning_meeting", "initial_planning_meeting_information",
      "training_event", "training_event_information",
      "final_briefing", "final_briefing_information",
      "buildup_day", "buildup_day_information",
      "reentry_workshop", "reentry_workshop_information",
      // Flights
      "flight_departure_date", "departure_airlines", "departure_routing",
      "return_flight_date", "return_flight_airlines", "return_flight_routing",
      // Payment schedule (1..10)
      "payment_date_1", "payment_amount_1",
      "payment_date_2", "payment_amount_2",
      "payment_date_3", "payment_amount_3",
      "payment_date_4", "payment_amount_4",
      "payment_date_5", "payment_amount_5",
      "payment_date_6", "payment_amount_6",
      "payment_date_7", "payment_amount_7",
      "payment_date_8", "payment_amount_8",
      "payment_date_9", "payment_amount_9",
      "payment_date_10", "payment_amount_10",
      // Student/family resources (manuals tab)
      "student_manual", "student_handbook", "gear_list", "selfdiscovery_workbook",
      "fundraising_guide", "fitness",
      "generic_kit_info_flyer", "fundraising_team_tool", "fundraising_templates",
      // Insurance + documents
      "insurance_overview__faqs", "insurance_policy_wording",
      "documents_upload_form",
      // Message board
      "message_board", "message_board_posted_at",
      // ============================================================
      // Trip Leader resource links (rendered as Details buttons at the
      // top of the Trip Leader tab; see TRIP_LEADER_LINKS in index.html
      // for the labels). Each one stores a single URL. Trip-level value
      // wins; if blank, falls back to the global record's value.
      // ============================================================
      "leader_manual",
      "leader_handbook",
      "generic_risk_assessment",
      "country_risk_assessment",
      "expedition_budget",
      "country_contact_list",
      "medical_manual",
      "inreach_manual",
      "satellite_phone_manual",
      "incident_report_link",
      "accommodation_audit_link",
      "activity_audit_link",
      "transport_audit_link",
      "wise_card_troubleshooting",
      "emergency_numbers__escalation",
      "expense__reimbursement_policies",
      "device_policies",
      "child_protection_policy"
    ].join(",");

    const tripPortalUrl   = `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?properties=${PORTAL_PROPERTIES}`;
    const globalPortalUrl = `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${GLOBAL_PORTAL_ID}?properties=${PORTAL_PROPERTIES}`;

    const [portalRes, globalRes] = await Promise.all([
      fetch(tripPortalUrl, { headers }),
      fetch(globalPortalUrl, { headers }).catch(() => null)
    ]);

    if (!portalRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Portal fetch failed",
          details: await portalRes.text()
        })
      };
    }

    const portal = await portalRes.json();
    let globalProps = {};
    if (globalRes && globalRes.ok) {
      try {
        const globalData = await globalRes.json();
        globalProps = globalData.properties || {};
      } catch (e) {
        // Non-fatal — we just won't have global fallback values this request.
        console.warn("Global portal parse warning:", e.message);
      }
    } else if (globalRes) {
      console.warn("Global portal fetch non-OK:", globalRes.status);
    }

    const tripProps = portal.properties || {};
    const merged = mergeWithGlobalFallback(tripProps, globalProps);

    // ----- Strip instructor-only fields from the response when the
    //       caller doesn't have an admin_role. -----
    // Simple, single rule mirroring the frontend: any non-empty
    // admin_role (Instructor, Admissions Advisor, Admissions Director,
    // etc.) sees the instructor rich-text body. Everyone else gets it
    // stripped from the JSON before send, so DOM manipulation has
    // nothing to surface. Admin viewers (adminPortalId path) always
    // retain the field — they need it for review/QA.
    const callerHasAdminRole = !adminPortalId
      ? !!(typeof callerAdminRole === "string" && callerAdminRole.length > 0)
      : true; // admin viewing path implicitly has admin access
    if (!callerHasAdminRole) {
      delete merged.trip_leader_information_content;
    }

    // ----- Key Contacts (Instructor Resources tab) -----
    // Resolved by LABEL against the live property schema (not by a guessed
    // internal name), so a missing or renamed property can never 400 the
    // whole portal fetch. Trip value wins, else global. Instructor/admin
    // only — same gate as the trip_leader rich-text block above.
    let keyContacts = {};
    if (callerHasAdminRole) {
      keyContacts = await fetchKeyContacts(portalId, GLOBAL_PORTAL_ID, OBJECT, headers);
    }

    console.log("PORTAL DATA (merged):", JSON.stringify(merged, null, 2));

    // 4. Return data. `availableTripCount` lets the frontend decide
    //    whether to show a "Switch trip" link in the header (only
    //    relevant for users associated with more than one portal).
    //    Admins viewing via portalId get null here (their picker is
    //    /admin.html).
    const availableTripCount = adminPortalId
      ? null
      : (associatedPortalIds ? associatedPortalIds.length : 1);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ...merged,
        labels,
        availableTripCount,
        keyContacts
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server error",
        details: err.message
      })
    };
  }
}

// Batch-reads minimal metadata for the multi-portal trip picker: enough
// for the user-facing card (title, date-range or destination, optional
// tuition/price). Used when an `email`-authenticated user has 2+
// associated portals and we need to surface them on /my-trips.html.
//
// Reads both the new program_* fields and the legacy portal_title /
// destination / price for migration-safe fallback. The returned shape
// keeps the legacy {title, destination, price} keys so my-trips.html
// doesn't have to change — `destination` is populated with a formatted
// date range when program_start_date / program_end_date are set, or
// the legacy `destination` string otherwise.
async function fetchPortalCards(portalIds, OBJECT, headers) {
  if (!portalIds || portalIds.length === 0) return [];

  function formatDateRange(start, end) {
    const fmt = (v) => {
      if (!v) return null;
      const d = new Date(v);
      if (isNaN(d.getTime())) return null;
      return d.toLocaleDateString("en-NZ", { year: "numeric", month: "short", day: "numeric" });
    };
    const s = fmt(start);
    const e = fmt(end);
    if (s && e) return `${s} – ${e}`;
    return s || e || "";
  }

  try {
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/batch/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: portalIds.map(id => ({ id: String(id) })),
          properties: [
            // New schema
            "program_name", "program_start_date", "program_end_date", "program_tuition",
            // Legacy fallback
            "portal_title", "destination", "price"
          ]
        })
      }
    );
    if (!res.ok) {
      console.warn("[portal] picker batch read non-OK:", res.status);
      return portalIds.map(id => ({ id, title: "(unknown trip)", destination: "", price: null }));
    }
    const data = await res.json();
    return (data.results || []).map(r => {
      const props = r.properties || {};
      const dateRange = formatDateRange(props.program_start_date, props.program_end_date);
      return {
        id: String(r.id),
        title: props.program_name || props.portal_title || "(untitled trip)",
        destination: dateRange || props.destination || "",
        price: props.program_tuition || props.price || null
      };
    }).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  } catch (err) {
    console.warn("[portal] picker batch read threw:", err?.message || err);
    return portalIds.map(id => ({ id, title: "(unknown trip)", destination: "", price: null }));
  }
}

// ===========================================================================
// Key Contacts (Instructor Resources tab)
// ===========================================================================
// The Key Contacts card shows a fixed set of emergency / HQ / local-emergency
// fields. Each entry maps a STABLE key (used by the frontend) to the HubSpot
// property LABEL. We resolve labels → internal names from the live property
// schema, so the portal never 400s if a property is absent or renamed — any
// field we can't resolve is simply skipped.
//
// Trip record value wins; if blank, the global record's value is used.
const KEY_CONTACT_FIELDS = [
  { key: "pd_emergency_usa", label: "Pacific Discovery Emergency Line (USA)" },
  { key: "pd_emergency_nz",  label: "Pacific Discovery Emergency Line (NZ)" },
  { key: "pd_hq_usa",        label: "Pacific Discovery Headquarters (USA)" },
  { key: "pd_hq_nz",         label: "Pacific Discovery Headquarters (NZ)" },
  { key: "travel_agent_247", label: "Travel Agent Contact (24/7)" },
  { key: "local_country_1",  label: "Local Emergency Number Country (1)" },
  { key: "local_number_1",   label: "Local Emergency Number (1)" },
  { key: "local_country_2",  label: "Local Emergency Number Country (2)" },
  { key: "local_number_2",   label: "Local Emergency Number (2)" },
  { key: "local_country_3",  label: "Local Emergency Number Country (3)" },
  { key: "local_number_3",   label: "Local Emergency Number (3)" },
  { key: "local_country_4",  label: "Local Emergency Number Country (4)" },
  { key: "local_number_4",   label: "Local Emergency Number (4)" },
  { key: "local_country_5",  label: "Local Emergency Number Country (5)" },
  { key: "local_number_5",   label: "Local Emergency Number (5)" },
  { key: "bhsi_concierge",   label: "BHSI Insurance Concierge" }
];

function normKeyContactLabel(s) {
  return String(s == null ? "" : s)
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Returns { stableKey: value } for every key-contact field that (a) exists on
// the object and (b) has a non-empty value on the trip or global record.
// Fully fault-tolerant: any failure returns {} so the portal still loads.
async function fetchKeyContacts(portalId, globalId, OBJECT, headers) {
  try {
    // 1. Resolve labels → existing internal names via the object schema.
    const schemaRes = await fetch(
      `https://api.hubapi.com/crm/v3/properties/${OBJECT}`,
      { headers }
    );
    if (!schemaRes.ok) {
      console.warn("[portal] key-contacts schema fetch non-OK:", schemaRes.status);
      return {};
    }
    const schema = await schemaRes.json();
    const nameByLabel = new Map();
    for (const p of (schema.results || [])) {
      if (p && p.label && p.name) nameByLabel.set(normKeyContactLabel(p.label), p.name);
    }

    const resolved = []; // { key, name }
    for (const f of KEY_CONTACT_FIELDS) {
      const name = nameByLabel.get(normKeyContactLabel(f.label));
      if (name) resolved.push({ key: f.key, name });
    }
    if (resolved.length === 0) return {};

    // 2. Fetch only the resolved (guaranteed-to-exist) properties from both
    //    the trip and global records, in parallel.
    const names = resolved.map(r => r.name).join(",");
    const [tRes, gRes] = await Promise.all([
      fetch(`https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?properties=${encodeURIComponent(names)}`, { headers }),
      fetch(`https://api.hubapi.com/crm/v3/objects/${OBJECT}/${globalId}?properties=${encodeURIComponent(names)}`, { headers }).catch(() => null)
    ]);

    const tProps = (tRes && tRes.ok) ? ((await tRes.json()).properties || {}) : {};
    let gProps = {};
    if (gRes && gRes.ok) {
      try { gProps = (await gRes.json()).properties || {}; } catch (e) { /* non-fatal */ }
    }

    // 3. Merge trip-priority and keep only non-empty values.
    const out = {};
    for (const r of resolved) {
      const t = tProps[r.name];
      const v = (t != null && String(t).trim() !== "")
        ? t
        : (gProps[r.name] != null ? gProps[r.name] : "");
      if (v != null && String(v).trim() !== "") out[r.key] = String(v).trim();
    }
    return out;
  } catch (err) {
    console.warn("[portal] key-contacts fetch failed:", err && err.message ? err.message : err);
    return {};
  }
}

// Merge a trip record's properties on top of the global record's. For each
// key, the trip's value wins if it's "non-empty" (not null/undefined and not
// an empty/whitespace-only string); otherwise the global record's value is
// used. Returns a flat object suitable for ...spread into the response.
function mergeWithGlobalFallback(tripProps, globalProps) {
  const out = {};
  const allKeys = new Set([
    ...Object.keys(tripProps || {}),
    ...Object.keys(globalProps || {})
  ]);
  for (const k of allKeys) {
    const t = tripProps ? tripProps[k] : undefined;
    if (t !== null && t !== undefined && String(t).trim() !== "") {
      out[k] = t;
    } else if (globalProps && globalProps[k] !== undefined) {
      out[k] = globalProps[k];
    } else {
      out[k] = null;
    }
  }
  return out;
}
