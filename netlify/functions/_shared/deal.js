// Resolves "which of this contact's deals is the portal showing?"
//
// Background: a contact can have several associated Deals, and until now
// every deal-backed endpoint independently took the most recently created
// one. In this HubSpot portal that is frequently the wrong deal. Three
// distinct situations produce multiple deals:
//
//   1. An add-on deal — "College Credits" ($1,950) or "Basecamp" ($799) —
//      alongside the real program deal, and usually created AFTER it. The
//      student should be able to switch between them, so add-ons are
//      first-class selectable enrolments here, not noise.
//   2. Accidental duplicates from a form or workflow double-firing: the
//      same deal name and amount created seconds or minutes apart, in
//      threes and fours. These must be collapsed silently — nobody should
//      be asked to choose between three identical records.
//   3. Genuinely separate programs, including alumni returning in a later
//      year. This is the case the picker exists for.
//
// So: classify, collapse the duplicates, and keep everything a student
// could legitimately want to look at. Selection order puts programs before
// add-ons, and the caller may override with an explicit deal id that is
// always validated against the contact's own associations.

import { parseDealPayments, totalPaidForDeal, PAYMENT_FIELDS } from "./payments.js";

// The `pd_program` ("PD Program") enumeration on the Deal is the authoritative
// answer to what a deal is for. Two of its values are add-ons rather than
// trips — a College Credit or Basecamp deal has no itinerary, no application
// fee and no deposit, so it must never drive the deposit buttons.
//
// Coverage check against the live portal: of 52 add-on deals, 51 carry
// `pd_program` (the exception is one 2024 record). It is much patchier on
// program deals — only ~100 of 375 deals created in 2026 have it, and the
// school-trip pipeline never does — hence the name-pattern fallback below.
// Both are needed: pd_program decides when present, the name guesses when not.
const ADDON_PD_PROGRAMS = new Set(
  (process.env.DEAL_ADDON_PD_PROGRAMS || "College Credit Program,Basecamp")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

// `pd_program` and `program_intake` values that mark a dead enrolment.
const CANCELLED_PD_PROGRAMS = new Set(
  (process.env.DEAL_CANCELLED_PD_PROGRAMS || "Dropped")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);
const CANCELLED_INTAKES = new Set(
  (process.env.DEAL_CANCELLED_INTAKES || "CANCELLATION")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Fallback for deals with no `pd_program`: guess the add-on from the name.
// Override with DEAL_ADDON_PATTERNS (a single regex source string).
const ADDON_PATTERN = new RegExp(
  process.env.DEAL_ADDON_PATTERNS || "college\\s*credits?|basecamp|insurance\\s*only",
  "i"
);

// Deal names that mark an enrolment as cancelled regardless of stage — the
// office renames records like "Jocelyn Glennie - Cancelled".
const CANCELLED_NAME_PATTERN = new RegExp(
  process.env.DEAL_CANCELLED_PATTERNS || "\\bcancell?ed\\b|\\bwithdrawn\\b|\\brefunded\\b",
  "i"
);

// Test/scratch pipelines. Being in one is a WEAK signal, not decisive: it
// only excludes a deal that also has nothing on it — no payments, no
// documents. A real enrolment that someone parked in a test pipeline still
// shows, because hiding a deal a student has actually paid against is far
// worse than showing one extra option.
// Override with DEAL_PIPELINE_DENYLIST as a comma-separated list of ids.
const EXCLUDED_PIPELINES = new Set(
  (process.env.DEAL_PIPELINE_DENYLIST || "12030850")
    .split(",").map(s => s.trim()).filter(Boolean)
);

// Optional property linking a deal to its Program (custom object
// 2-58411705) record. Not yet populated in HubSpot — when it is, it
// becomes the decisive signal and the name matching below is only a
// fallback for legacy records.
const PROGRAM_LINK_PROPERTY = process.env.DEAL_PROGRAM_ID_PROPERTY || "portal_program_id";

// Optional property letting ops override the classification directly:
// "program" | "addon" | "ignore".
const ROLE_PROPERTY = process.env.DEAL_ROLE_PROPERTY || "portal_deal_role";

export const DOCUMENTS_NEEDED_PROPERTY =
  process.env.DOCUMENTS_NEEDED_PROPERTY || "document_submissions";

export const DEAL_PROPERTIES = Object.freeze([
  "dealname", "createdate", "amount", "total_amount_paid",
  "pipeline", "dealstage", "hs_is_closed", "hs_is_closed_won",
  "program_start_date",
  // "PD Program" — the enumeration naming what this deal is actually for.
  // Primary classifier and the best available program name.
  "pd_program", "program_intake",
  DOCUMENTS_NEEDED_PROPERTY,
  PROGRAM_LINK_PROPERTY,
  ROLE_PROPERTY,
  ...PAYMENT_FIELDS
]);

// ---------------------------------------------------------------------------
// pure helpers (unit-tested in tests/deal.test.mjs)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["the", "and", "a", "of", "program", "programme", "semester", "gap"]);

export function normaliseName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Deal names follow "<student name> - <Program Name>", e.g.
// "Jonas Fritzsche - New Zealand and Australia Gap Semester". Returns the
// part after the last separator, or the whole name when there isn't one
// ("Rachel Stern", "KeenanBhansali").
export function programPartOfName(dealname) {
  const raw = String(dealname || "").trim();
  if (!raw) return "";
  const parts = raw.split(/\s+[-–—]\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : raw).trim();
}

// The best name we have for what a deal is for: the `pd_program` value when
// set (a clean enumeration value like "Hawaii Mini Semester"), otherwise the
// part of the deal name after the student's name.
export function programNameOfDeal(props = {}) {
  const pd = String(props.pd_program || "").trim();
  if (pd) return pd;
  return programPartOfName(props.dealname);
}

// Fraction of the program's significant words that appear in the deal's
// program name. 0 when either side has nothing to compare.
export function nameOverlap(dealname, programName) {
  const dealTokens = new Set(normaliseName(programPartOfName(dealname)).split(" ").filter(Boolean));
  const programTokens = normaliseName(programName).split(" ")
    .filter(t => t && !STOP_WORDS.has(t));
  if (!programTokens.length || !dealTokens.size) return 0;
  const hits = programTokens.filter(t => dealTokens.has(t)).length;
  return hits / programTokens.length;
}

function hasAnyPayment(props) {
  return PAYMENT_FIELDS.some(f => String(props[f] || "").trim());
}

// Nothing has happened on this deal: no money in, no documents asked for.
// Used to decide whether a scratch-pipeline record is real.
export function isEmptyOfActivity(props = {}) {
  const hasDocs = Boolean(String(props[DOCUMENTS_NEEDED_PROPERTY] || "").trim());
  const paid = parseFloat(props.total_amount_paid);
  const hasPaid = Number.isFinite(paid) && paid > 0;
  return !hasDocs && !hasPaid && !hasAnyPayment(props);
}

// A deal with no money, no payments and no document requirements is an
// abandoned shell — it should never be what a student lands on.
export function isStaleShell(props = {}) {
  const amount = parseFloat(props.amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const hasDocs = Boolean(String(props[DOCUMENTS_NEEDED_PROPERTY] || "").trim());
  const hasPaid = Number.isFinite(parseFloat(props.total_amount_paid)) && parseFloat(props.total_amount_paid) > 0;
  return !hasAmount && !hasDocs && !hasPaid && !hasAnyPayment(props);
}

function hasMoneyAgainstIt(props = {}) {
  const paid = parseFloat(props.total_amount_paid);
  return (Number.isFinite(paid) && paid > 0) || hasAnyPayment(props);
}

// A deal that was closed WITHOUT being won, and against which nothing was
// ever paid, is a cancelled or lost enrolment. Before the switcher existed
// these were unreachable from the UI; exposing them would put a live "PAY
// NOW" link on a trip the student is not going on. Closed-WON deals stay
// selectable — a fully-paid past program is exactly what an alumnus wants to
// be able to look back at.
export function isCancelled(props = {}) {
  const closed = String(props.hs_is_closed || "") === "true";
  const won = String(props.hs_is_closed_won || "") === "true";
  if (!closed || won) return false;
  return !hasMoneyAgainstIt(props);
}

// True when the CRM marks this enrolment dead: pd_program "Dropped", or a
// program_intake of "CANCELLATION", or a deal renamed "… - Cancelled".
//
// All three are ignored ONLY when no money was ever taken. If a student paid
// and then cancelled, they need to see those payments (and chase the refund) —
// hiding the deal would hide their own history.
export function isMarkedDead(props = {}) {
  if (hasMoneyAgainstIt(props)) return false;
  if (CANCELLED_PD_PROGRAMS.has(String(props.pd_program || "").trim().toLowerCase())) return true;
  if (CANCELLED_INTAKES.has(String(props.program_intake || "").trim().toLowerCase())) return true;
  if (CANCELLED_NAME_PATTERN.test(String(props.dealname || ""))) return true;
  return false;
}

// "program" | "addon" | "ignore"
export function classifyDeal(deal) {
  const props = deal?.properties || {};

  const explicit = String(props[ROLE_PROPERTY] || "").trim().toLowerCase();
  if (explicit === "program" || explicit === "addon" || explicit === "ignore") return explicit;

  // A scratch-pipeline deal is only ignored when it is also empty — see the
  // note on EXCLUDED_PIPELINES.
  if (EXCLUDED_PIPELINES.has(String(props.pipeline || "")) && isEmptyOfActivity(props)) {
    return "ignore";
  }
  if (isStaleShell(props)) return "ignore";
  if (isCancelled(props)) return "ignore";
  if (isMarkedDead(props)) return "ignore";

  // pd_program decides when it is set — including deciding that a deal IS a
  // program. That ordering matters: "Jonas Fritzsche - New Zealand and
  // Australia Gap Semester" carries college_credit = "Yes" (he bought credit
  // alongside his semester) and a name containing neither add-on word, while
  // a semester deal named "… - Credit Transfer" would trip the name pattern.
  // The enumeration is right in both cases; the name is only a guess.
  const pdProgram = String(props.pd_program || "").trim().toLowerCase();
  if (pdProgram) {
    return ADDON_PD_PROGRAMS.has(pdProgram) ? "addon" : "program";
  }

  // No pd_program (about 3 in 4 program deals, and one known add-on) — fall
  // back to reading the deal name.
  if (ADDON_PATTERN.test(String(props.dealname || ""))) return "addon";
  return "program";
}

// Duplicates are the same normalised name at the same amount, created close
// together. The time window matters: the double-fires land seconds or minutes
// apart, but a returning student can enrol on the SAME program at the SAME
// price in a later year, and collapsing those would hide a real enrolment
// (and its payment history) behind the newer one.
const DUPLICATE_WINDOW_MS = Number(process.env.DEAL_DUPLICATE_WINDOW_HOURS || 48) * 3600e3;

export function dedupeKey(deal) {
  const props = deal?.properties || {};
  const amount = parseFloat(props.amount);
  const amountKey = Number.isFinite(amount) ? amount.toFixed(2) : "none";
  return `${normaliseName(props.dealname)}::${amountKey}`;
}

// True when two same-key deals are close enough in time to be one accident.
export function withinDuplicateWindow(a, b) {
  const ta = createdMs(a);
  const tb = createdMs(b);
  if (!ta || !tb) return true; // no timestamps to separate them by
  return Math.abs(ta - tb) <= DUPLICATE_WINDOW_MS;
}

// How much real content a record carries — used to decide which member of a
// duplicate group to keep. A double-fire usually leaves one record that the
// office subsequently worked on and one that stayed empty.
export function richness(deal) {
  const props = deal?.properties || {};
  let score = 0;
  score += PAYMENT_FIELDS.filter(f => String(props[f] || "").trim()).length * 3;
  if (String(props[DOCUMENTS_NEEDED_PROPERTY] || "").trim()) score += 2;
  if (parseFloat(props.total_amount_paid) > 0) score += 2;
  if (parseFloat(props.amount) > 0) score += 1;
  if (String(props[PROGRAM_LINK_PROPERTY] || "").trim()) score += 5;
  return score;
}

function createdMs(deal) {
  const t = new Date(deal?.properties?.createdate || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Collapses duplicate groups, keeping the richest record (newest breaks a
// tie). The dropped ids are recorded on the survivor as `mergedIds` so a
// stale `?deal=` link still resolves.
export function collapseDuplicates(deals) {
  const groups = new Map();
  for (const deal of deals) {
    const key = dedupeKey(deal);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(deal);
  }

  const kept = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push({ deal: group[0], mergedIds: [] });
      continue;
    }

    // Split same-key deals into time clusters, so three records created
    // within an hour collapse to one while the same program bought again two
    // years later stays its own enrolment.
    const byTime = group.slice().sort((a, b) => createdMs(a) - createdMs(b));
    const clusters = [[byTime[0]]];
    for (const deal of byTime.slice(1)) {
      const current = clusters[clusters.length - 1];
      if (withinDuplicateWindow(current[current.length - 1], deal)) current.push(deal);
      else clusters.push([deal]);
    }

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        kept.push({ deal: cluster[0], mergedIds: [] });
        continue;
      }
      const ordered = cluster.slice().sort((a, b) => {
        const diff = richness(b) - richness(a);
        return diff !== 0 ? diff : createdMs(b) - createdMs(a);
      });
      kept.push({
        deal: ordered[0],
        mergedIds: ordered.slice(1).map(d => String(d.id))
      });
    }
  }
  return kept;
}

// Score a program deal against the Program record being viewed. Add-ons are
// not scored against the program — they belong to whatever trip the student
// is on and are ordered by recency instead.
export function scoreAgainstProgram(deal, program = {}) {
  const props = deal?.properties || {};
  let score = 0;

  const linked = String(props[PROGRAM_LINK_PROPERTY] || "").trim();
  if (linked && program.portalId && linked === String(program.portalId)) score += 100;

  // An exact pd_program match against the Program record's name is nearly as
  // good as a hard id link — it is a controlled enumeration, not free text.
  const pdProgram = String(props.pd_program || "").trim();
  if (pdProgram && program.programName &&
      normaliseName(pdProgram) === normaliseName(program.programName)) {
    score += 80;
  }

  if (program.programName) {
    // Compare on pd_program when we have it, since it is cleaner than the
    // name fragment after the student's name.
    score += 60 * nameOverlap(pdProgram || props.dealname, program.programName);
  }

  const tuition = parseFloat(program.programTuition);
  const amount = parseFloat(props.amount);
  if (Number.isFinite(tuition) && Number.isFinite(amount) && tuition > 0 && Math.abs(tuition - amount) < 0.5) {
    score += 25;
  }

  if (program.programStartDate && props.program_start_date) {
    const a = new Date(program.programStartDate).getTime();
    const b = new Date(props.program_start_date).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 30 * 864e5) score += 10;
  }

  return score;
}

// Turns raw HubSpot deals into the enrolment list the portal and the
// switcher work from. Sorted: programs (best match first), then add-ons
// (newest first).
export function buildEnrolments(deals, program = {}) {
  const usable = [];
  const ignored = [];

  for (const deal of deals || []) {
    if (classifyDeal(deal) === "ignore") ignored.push(deal);
    else usable.push(deal);
  }

  // If everything was filtered out, show it anyway — an empty portal is
  // worse than a thin one.
  const source = usable.length ? usable : (deals || []);

  const enrolments = collapseDuplicates(source).map(({ deal, mergedIds }) => {
    const props = deal.properties || {};
    // When nothing survived the filters we fall back to the raw list rather
    // than an empty portal — but such a record is labelled "other", so the UI
    // doesn't call a test-pipeline or cancelled deal a program.
    const rawClass = classifyDeal(deal);
    const kind = rawClass === "addon" ? "addon" : (rawClass === "ignore" ? "other" : "program");
    const payments = parseDealPayments(props);
    const { totalPaid, source: paidSource } = totalPaidForDeal(props, payments);
    const amount = parseFloat(props.amount);

    return {
      id: String(deal.id),
      mergedIds,
      kind,
      name: props.dealname || (kind === "addon" ? "Add-on" : "Program"),
      // What the switcher shows. pd_program gives a clean label
      // ("College Credit Program") where the deal name might be
      // "Jonas - College Credits " or just "Rachel Stern".
      programPart: programNameOfDeal(props),
      pdProgram: String(props.pd_program || "").trim() || null,
      amount: Number.isFinite(amount) ? amount : null,
      totalPaid,
      totalPaidSource: paidSource,
      amountDue: Number.isFinite(amount) ? Math.max(0, round2(amount - totalPaid)) : null,
      payments,
      documentsNeededRaw: String(props[DOCUMENTS_NEEDED_PROPERTY] || "").trim(),
      createdate: props.createdate || null,
      isClosed: String(props.hs_is_closed || "") === "true",
      score: kind === "program" ? scoreAgainstProgram(deal, program) : 0,
      properties: props
    };
  });

  enrolments.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "program" ? -1 : 1;
    if (a.kind === "program" && b.score !== a.score) return b.score - a.score;
    return new Date(b.createdate || 0) - new Date(a.createdate || 0);
  });

  return { enrolments, ignoredIds: ignored.map(d => String(d.id)) };
}

// Picks the enrolment to render. An explicit request wins as long as it
// belongs to this contact; a request for a collapsed duplicate resolves to
// its survivor.
export function pickEnrolment(enrolments, requestedDealId) {
  if (!enrolments.length) return null;
  const wanted = requestedDealId == null ? "" : String(requestedDealId).trim();
  if (wanted) {
    const exact = enrolments.find(e => e.id === wanted);
    if (exact) return exact;
    const merged = enrolments.find(e => e.mergedIds.includes(wanted));
    if (merged) return merged;
  }
  return enrolments[0];
}

// Trimmed shape for the client. Deliberately omits raw HubSpot properties
// and payment strings — the switcher only needs labels and figures.
export function toClientEnrolment(e, selectedId) {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    label: e.programPart || e.name,
    pdProgram: e.pdProgram || null,
    amount: e.amount,
    totalPaid: e.totalPaid,
    amountDue: e.amountDue,
    selected: e.id === selectedId
  };
}

// ---------------------------------------------------------------------------
// HubSpot I/O
// ---------------------------------------------------------------------------

export function hubspotHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

export async function findContactIdByEmail(email, headers = hubspotHeaders(), extraProperties = []) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", ...extraProperties]
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Contact lookup failed (HubSpot ${res.status})`);
    err.details = text.slice(0, 300);
    throw err;
  }
  const data = await res.json();
  const contact = data.results?.[0] || null;
  return contact ? { id: String(contact.id), properties: contact.properties || {} } : null;
}

// Throws on a HubSpot read failure rather than returning an empty list.
// Returning [] made a 429 or 500 indistinguishable from "this student has no
// deals", which rendered as PROGRAM TOTAL TBC / PAID $0 / DUE $0 — a
// confidently wrong page instead of an error the student can act on.
function readFailed(what, res, body) {
  const err = new Error(`${what} failed (HubSpot ${res.status})`);
  err.details = String(body || "").slice(0, 300);
  err.isUpstream = true;
  return err;
}

export async function fetchDealsForContact(contactId, headers = hubspotHeaders()) {
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers }
  );
  if (!assocRes.ok) {
    throw readFailed("Deal association lookup", assocRes, await assocRes.text().catch(() => ""));
  }

  const assocData = await assocRes.json();
  const associatedIds = (assocData.results || [])
    .map(r => r.toObjectId)
    .filter(v => v != null)
    .map(String);
  if (!associatedIds.length) return { deals: [], associatedIds };

  const dealsRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: associatedIds.map(id => ({ id })),
      properties: [...DEAL_PROPERTIES]
    })
  });
  if (!dealsRes.ok) {
    throw readFailed("Deal batch-read", dealsRes, await dealsRes.text().catch(() => ""));
  }

  const dealsData = await dealsRes.json();
  return { deals: dealsData.results || [], associatedIds };
}

// One call for the common case: email → enrolments + the selected one.
//
// `requestedDealId` comes from the client, so it is only honoured when it is
// in the contact's own association list. Same guard as the existing
// `?picked=` portal check — a deal id from the browser is never trusted.
export async function resolveEnrolmentsForEmail(email, {
  program = {},
  requestedDealId = null,
  headers = hubspotHeaders()
} = {}) {
  const contact = await findContactIdByEmail(email, headers);
  if (!contact) return { contactId: null, enrolments: [], selected: null, associatedIds: [] };

  const { deals, associatedIds } = await fetchDealsForContact(contact.id, headers);
  const { enrolments, ignoredIds } = buildEnrolments(deals, program);

  const validRequest = requestedDealId && associatedIds.includes(String(requestedDealId))
    ? String(requestedDealId)
    : null;

  return {
    contactId: contact.id,
    contactProperties: contact.properties,
    associatedIds,
    ignoredIds,
    enrolments,
    selected: pickEnrolment(enrolments, validRequest),
    requestHonoured: Boolean(validRequest)
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
