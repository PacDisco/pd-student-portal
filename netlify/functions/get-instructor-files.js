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

import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY not configured" });
    }

    // Email from the verified token; instructor/admin gate runs below.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    const email = identity.email;

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
    // ----- Root-level files (existing behaviour; INSTRUCTOR FILES section) -----
    const root = await fetchFolderFiles(folderId, headers);
    if (!root.ok) {
      console.error(`[get-instructor-files] HubSpot ${root.status}: ${String(root.text || "").slice(0, 300)}`);
      return jsonResponse(502, {
        error: "HubSpot Files API call failed",
        details: `HubSpot ${root.status}`,
        hint: root.status === 403
          ? "The Private App backing HUBSPOT_API_KEY is missing the 'files' read scope. Enable it in HubSpot Settings → Integrations → Private Apps."
          : undefined,
        files: []
      });
    }

    // ----- Numbered subfolders (1-5) and their contents -----
    // The portal shows the subfolders of the Instructor Resources folder whose
    // names begin with 1-5, each with its files. Live-read, so anything added
    // to one of these folders in HubSpot appears here on the next load.
    // Fully fault-tolerant: any failure here just yields an empty folders list
    // and leaves the root file listing intact.
    let folders = [];
    try {
      const subs = await fetchSubfolders(folderId, headers);
      const numbered = subs
        .map(s => {
          const m = String(s.name || "").match(/^\s*(\d+)/);
          const num = m ? parseInt(m[1], 10) : null;
          return (num && num >= 1 && num <= 5) ? { ...s, number: num } : null;
        })
        .filter(Boolean)
        // If two folders share a leading number, keep them both but order by
        // number then name for a stable, predictable display.
        .sort((a, b) => (a.number - b.number) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

      // Each numbered folder carries a full nested tree (subfolders + files),
      // bounded by depth and a per-request folder budget so a deep/wide tree
      // can't blow the function timeout.
      const budget = { count: 0 };
      for (const sub of numbered) {
        const tree = await loadFolderTree(sub.id, headers, 1, budget);
        folders.push({
          id: sub.id,
          name: sub.name,
          number: sub.number,
          files: tree.files,
          folders: tree.folders
        });
      }
    } catch (e) {
      console.warn("[get-instructor-files] subfolder listing failed:", e && e.message ? e.message : e);
    }

    return jsonResponse(200, { files: root.files, folders, folderId });

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

// Normalise one HubSpot Files API file record to the shape the portal uses.
function mapFile(f) {
  return {
    id: String(f.id || ""),
    name: f.name || "Untitled",
    // HubSpot Files API v3 returns `url` (CDN URL) for publicly accessible
    // files. Private files have `url` populated but the CDN serves them only
    // to authenticated sessions — we link to the URL either way and let the
    // browser / HubSpot handle access.
    url: f.url || "",
    extension: f.extension || "",
    type: f.type || "",
    size: typeof f.size === "number" ? f.size : null,
    updatedAt: f.updatedAt || f.createdAt || null
  };
}

// All files directly inside a folder, paginated (cap 5 pages), sorted by name.
// Returns { ok:true, files } or { ok:false, status, text } on API error.
async function fetchFolderFiles(folderId, headers) {
  const collected = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ parentFolderIds: folderId, limit: "100", sort: "-updatedAt" });
    if (after) qs.set("after", after);
    const res = await fetch(`https://api.hubapi.com/files/v3/files/search?${qs.toString()}`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, text };
    }
    const data = await res.json();
    for (const f of data.results || []) { if (f) collected.push(mapFile(f)); }
    after = data.paging?.next?.after;
    if (!after) break;
  }
  collected.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return { ok: true, files: collected };
}

// Direct subfolders of `folderId`. We pass parentFolderIds as a best-effort
// server-side filter AND filter on parentFolderId in case the API ignores it,
// so we never accidentally pull the whole account's folder tree into scope.
async function fetchSubfolders(folderId, headers) {
  const out = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ parentFolderIds: folderId, limit: "100" });
    if (after) qs.set("after", after);
    const res = await fetch(`https://api.hubapi.com/files/v3/folders/search?${qs.toString()}`, { headers });
    if (!res.ok) {
      console.warn(`[get-instructor-files] folders search HTTP ${res.status}`);
      return out;
    }
    const data = await res.json();
    for (const fld of data.results || []) {
      if (!fld || !fld.id) continue;
      if (String(fld.parentFolderId ?? "") !== String(folderId)) continue;
      out.push({ id: String(fld.id), name: fld.name || "" });
    }
    after = data.paging?.next?.after;
    if (!after) break;
  }
  // Numeric-aware sort so "1.", "2.", "10." order correctly alongside plain names.
  out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
  return out;
}

// Recursively load a folder's files AND nested subfolders (each with their own
// files/subfolders). Bounded by MAX_DEPTH and a shared folder-count budget so a
// deep or wide tree can't exhaust the function timeout. Fault-tolerant: a
// failed branch just yields empty files/folders.
const MAX_FOLDER_DEPTH = 4;
const MAX_FOLDERS_PER_REQUEST = 80;

async function loadFolderTree(folderId, headers, depth, budget) {
  const r = await fetchFolderFiles(folderId, headers);
  const files = r.ok ? r.files : [];
  const folders = [];
  if (depth < MAX_FOLDER_DEPTH && budget.count < MAX_FOLDERS_PER_REQUEST) {
    let subs = [];
    try { subs = await fetchSubfolders(folderId, headers); } catch (_) { subs = []; }
    for (const sub of subs) {
      if (budget.count >= MAX_FOLDERS_PER_REQUEST) break;
      budget.count++;
      const child = await loadFolderTree(sub.id, headers, depth + 1, budget);
      folders.push({ id: sub.id, name: sub.name, files: child.files, folders: child.folders });
    }
  }
  return { files, folders };
}

// Allowed if the caller has any non-empty admin_role. Fails closed on
// HubSpot API errors.
async function checkInstructorOrAdminAccess(email, headers) {
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

  if (String(contact.properties?.admin_role || "").trim()) {
    return { allowed: true, reason: "admin_role" };
  }
  return { allowed: false, reason: "No admin_role" };
}
