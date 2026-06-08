// Returns every Portal (custom object 2-58411705) in HubSpot — used by
// the admin trip picker (/admin.html). For each portal we include a flag
// indicating whether it's associated to the admin's contact, so the
// frontend can group "your trips" above "other trips".
//
// Inputs (querystring):
//   email — admin's email. Required. Used to compute `associated`.
//
// Required env var: HUBSPOT_API_KEY
//
// Notes:
//   - The Portal object id "2-58411705" matches what portal.js already uses.
//   - The "global" defaults record (id 54796059552) is filtered out — it's
//     not a real trip, just shared content. Avoiding it in the picker.
//   - Only contacts with admin_role set should be hitting this endpoint.
//     We don't enforce that here yet (no auth layer); the frontend checks
//     adminRole from sessionStorage before navigating to /admin.html. If
//     this is ever exposed at a stable URL we'll add server-side gating.

const PORTAL_OBJECT_ID = "2-58411705";
const GLOBAL_PORTAL_ID = "54796059552";

import { authenticateAdmin, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    // Admin-only: identity (and admin role) come from the verified token.
    let identity;
    try { identity = await authenticateAdmin(event); } catch (e) { return authError(e); }
    const email = identity.email;
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY is not set" });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Resolve the admin's contact ID so we can list their portal
    //    associations. If the contact doesn't exist we still proceed —
    //    the picker just won't have any "Your trips" section.
    let contactId = null;
    try {
      const contactRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filterGroups: [{
              filters: [{ propertyName: "email", operator: "EQ", value: email }]
            }],
            properties: ["email", "admin_role"]
          })
        }
      );
      if (contactRes.ok) {
        const contactData = await contactRes.json();
        contactId = contactData.results?.[0]?.id || null;
      }
    } catch (err) {
      console.warn("[get-portals] contact lookup failed:", err?.message || err);
    }

    // 2. Get every portal ID this contact is associated to.
    const associatedIds = new Set();
    if (contactId) {
      try {
        const assocRes = await fetch(
          `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT_ID}`,
          { headers }
        );
        if (assocRes.ok) {
          const assocData = await assocRes.json();
          for (const r of assocData.results || []) {
            if (r.toObjectId != null) associatedIds.add(String(r.toObjectId));
          }
        }
      } catch (err) {
        console.warn("[get-portals] associations fetch failed:", err?.message || err);
      }
    }

    // 3. Fetch every Portal record. Paginate using HubSpot's `after` cursor
    //    in case there's ever more than one page; capping at 5 pages so a
    //    runaway never burns the function timeout.
    const portals = [];
    let after = undefined;
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({
        limit: "100",
        // Request both new (program_*) and legacy properties so the admin
        // trip-picker can fall back gracefully on un-migrated records.
        properties: "program_name,program_start_date,program_end_date,program_tuition,portal_title,destination,price,hs_object_id"
      });
      if (after) qs.set("after", after);

      const listRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT_ID}?${qs.toString()}`,
        { headers }
      );
      if (!listRes.ok) {
        const text = await listRes.text().catch(() => "");
        console.error(`[get-portals] portal list ${listRes.status}: ${text.slice(0, 200)}`);
        return jsonResponse(502, {
          error: "Could not list portals",
          details: `HubSpot ${listRes.status}`
        });
      }
      const listData = await listRes.json();
      for (const r of listData.results || []) {
        // Skip the global defaults record — it's not a real trip.
        if (String(r.id) === GLOBAL_PORTAL_ID) continue;
        // Compute a date-range label from new program_start/end_date,
        // falling back to the legacy destination string for the picker
        // card's secondary line.
        const props = r.properties || {};
        const fmt = (v) => {
          if (!v) return null;
          const d = new Date(v);
          if (isNaN(d.getTime())) return null;
          return d.toLocaleDateString("en-NZ", { year: "numeric", month: "short", day: "numeric" });
        };
        const startStr = fmt(props.program_start_date);
        const endStr   = fmt(props.program_end_date);
        const dateRange = (startStr && endStr) ? `${startStr} – ${endStr}` : (startStr || endStr || "");

        portals.push({
          id: String(r.id),
          title: props.program_name || props.portal_title || "(untitled trip)",
          destination: dateRange || props.destination || "",
          price: props.program_tuition || props.price || null,
          // Raw program_end_date so the admin trip-picker can hide trips
          // that ended >10 days ago for Instructor admins. Kept as the
          // raw HubSpot value (millisecond epoch or YYYY-MM-DD) so the
          // frontend's Date() parsing handles both.
          endDate: props.program_end_date || null,
          associated: associatedIds.has(String(r.id))
        });
      }
      after = listData.paging?.next?.after;
      if (!after) break;
    }

    // Sort: associated first, then alphabetical by title.
    portals.sort((a, b) => {
      if (a.associated !== b.associated) return a.associated ? -1 : 1;
      return (a.title || "").localeCompare(b.title || "");
    });

    return jsonResponse(200, { portals });

  } catch (err) {
    console.error("[get-portals] unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}
