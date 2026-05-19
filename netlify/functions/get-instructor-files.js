// Lists files in the Pacific Discovery "Instructor Resources" HubSpot Files
// folder so the portal's INSTRUCTOR RESOURCES tab can render them as link
// cards. Live-reads from HubSpot, so adding / removing files there flows
// through to the portal without code changes.
//
// Response shape:
//   {
//     files: [
//       { id, name, url, type, updatedAt, size }
//     ],
//     folderId: "212982599465"
//   }
//
// Required env var: HUBSPOT_API_KEY
//   The Private App backing this key must have the Files "read" scope
//   enabled. If it doesn't, the Files API returns 403 and this function
//   returns { error: "..." } with no files. Update the private app at
//   HubSpot Settings → Integrations → Private Apps → [your app] → Scopes.
//
// Optional env var: INSTRUCTOR_FILES_FOLDER_ID
//   Override the folder ID if the resources move to a different HubSpot
//   Files folder. Defaults to 212982599465.

const DEFAULT_FOLDER_ID = process.env.INSTRUCTOR_FILES_FOLDER_ID || "212982599465";

export async function handler(event) {
  try {
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY not configured" });
    }

    const email = (event.queryStringParameters?.email || "").toLowerCase().trim();
    if (!email) {
      return jsonResponse(401, { error: "Authentication required" });
    }

    const folderId = (event.queryStringParameters?.folderId || DEFAULT_FOLDER_ID).trim();
    if (!folderId) {
      return jsonResponse(400, { error: "Missing folderId" });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // ----- Server-side access check -----
    // Instructor Resources contains internal documents that should not
    // be visible to parents or students. Allow access only to:
    //   - any contact with a non-empty admin_role (admins of any kind)
    //   - any contact with an "Instructor" association to ANY program
    // Reject everyone else with 403.
    const access = await checkInstructorOrAdminAccess(email, headers);
    if (!access.allowed) {
      console.warn(`[get-instructor-files] Denied for ${email}: ${access.reason}`);
      return jsonResponse(403, { error: "Not authorized to view instructor resources." });
    }

    // HubSpot Files API v3 — search endpoint with a parentFolderIds filter.
    // Pagination via `after` cursor; cap at 5 pages so a runaway never
    // burns the function timeout.
    const collected = [];
    let after = undefined;
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({
        parentFolderIds: folderId,
        limit: "100",
        sort: "-updatedAt"
      });
      if (after) qs.set("after", after);

      const res = await fetch(
        `https://api.hubapi.com/files/v3/files/search?${qs.toString()}`,
        { headers }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[get-instructor-files] HubSpot ${res.status}: ${text.slice(0, 300)}`);
        return jsonResponse(502, {
          error: "HubSpot Files API call failed",
          details: `HubSpot ${res.status}`,
          hint: res.status === 403
            ? "The Private App backing HUBSPOT_API_KEY is missing the 'files' read scope. Enable it in HubSpot Settings → Integrations → Private Apps."
            : undefined,
          files: []
        });
      }
      const data = await res.json();
      for (const f of data.results || []) {
        if (!f) continue;
        collected.push({
          id: String(f.id || ""),
          name: f.name || "Untitled",
          // HubSpot Files API v3 returns `url` (CDN URL) for publicly
          // accessible files. Private files have `url` populated but the
          // CDN serves them only to authenticated sessions — we link to
          // the URL either way and let the browser/HubSpot handle access.
          url: f.url || "",
          extension: f.extension || "",
          type: f.type || "",
          size: typeof f.size === "number" ? f.size : null,
          updatedAt: f.updatedAt || f.createdAt || null
        });
      }
      after = data.paging?.next?.after;
      if (!after) break;
    }

    // Sort alphabetically by name for predictable display, regardless of
    // upload order. (Override by setting `sort` on the request if needed.)
    collected.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

    return jsonResponse(200, { files: collected, folderId });

  } catch (err) {
    console.error("[get-instructor-files] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error", files: [] });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// Allowed if the caller has any non-empty admin_role, OR is associated to
// any program with the "Instructor" label. Fails closed on HubSpot errors.
async function checkInstructorOrAdminAccess(email, headers) {
  // 1. Find contact + read admin_role.
  let contact;
  try {
    const res = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: email }]
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

  // 2. Any non-empty admin_role → access.
  if (String(contact.properties?.admin_role || "").trim()) {
    return { allowed: true, reason: "admin_role" };
  }

  // 3. Otherwise check for Instructor association to ANY program.
  // The Pacific Discovery Program object id is 2-58411705.
  try {
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contact.id}/associations/2-58411705`,
      { headers }
    );
    if (!assocRes.ok) return { allowed: false, reason: `Association lookup HTTP ${assocRes.status}` };
    const assocData = await assocRes.json();
    for (const r of assocData.results || []) {
      const labels = (r.associationTypes || []).map(t => t.label);
      if (labels.includes("Instructor")) {
        return { allowed: true, reason: "instructor_association" };
      }
    }
  } catch (err) {
    return { allowed: false, reason: `Association lookup threw: ${err.message}` };
  }

  return { allowed: false, reason: "No matching admin_role or Instructor association" };
}
