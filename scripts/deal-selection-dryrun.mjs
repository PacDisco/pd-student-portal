// Read-only before/after report for the enrolment-resolver change.
//
// Run this BEFORE deploying. It walks every contact that has more than one
// associated deal and prints what the portal shows today (newest deal by
// createdate, old payment parser) next to what it will show afterwards
// (resolved enrolment, new parser) — so you can eyeball whose figures move,
// and in particular whose AMOUNT DUE goes UP, since those are the students
// who may have seen a smaller balance and could reasonably query it.
//
// Usage:
//   HUBSPOT_API_KEY=... node scripts/deal-selection-dryrun.mjs [--csv out.csv] [--limit 500]
//
// Makes no writes of any kind.

import { writeFileSync } from "node:fs";
import { buildEnrolments, DEAL_PROPERTIES } from "../netlify/functions/_shared/deal.js";
import { parseDealPayments, totalPaidForDeal } from "../netlify/functions/_shared/payments.js";

const API_KEY = process.env.HUBSPOT_API_KEY;
if (!API_KEY) {
  console.error("HUBSPOT_API_KEY is not set.");
  process.exit(1);
}

const args = process.argv.slice(2);
const csvPath = argValue("--csv");
const limit = Number(argValue("--limit") || 0) || Infinity;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

// ---------------------------------------------------------------------------
// The OLD behaviour, reimplemented exactly so the diff is real: most recently
// created deal wins, and payment_N amounts come from the first
// comma-separated token with non-numeric characters stripped.
// ---------------------------------------------------------------------------
function oldSelection(deals) {
  return deals.slice().sort((a, b) => {
    const ta = new Date(a.properties?.createdate || 0).getTime();
    const tb = new Date(b.properties?.createdate || 0).getTime();
    return tb - ta;
  })[0];
}

// Replicates the amount logic the PAYMENTS TAB used (get-paid-payments.js's
// parsePaymentEntry), because that is what the student actually saw. Note
// this differs from the roster's old extractor in get-students.js, which
// looked only at the first comma-separated token — the two disagreed on
// labelled entries, one returning 937.50 and the other null for the same
// $12,500 payment.
function oldExtractAmount(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const piMatch = trimmed.match(/pi_[A-Za-z0-9]+/);
  const withoutPi = (piMatch ? trimmed.replace(piMatch[0], "") : trimmed).replace(/,\s*,/g, ",");
  const tokens = withoutPi.split(",").map(s => s.trim()).filter(Boolean);
  const oldLooksLikeDate = (s) =>
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s) ||
    /^\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(s) ||
    /^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s) ||
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d/i.test(s);
  for (const tok of tokens) {
    if (oldLooksLikeDate(tok)) continue;
    const cleaned = tok.replace(/[^0-9.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") continue;
    const n = parseFloat(cleaned);
    if (isFinite(n) && n > 0) return n;
  }
  return null;
}

function oldTotals(deal) {
  const props = deal?.properties || {};
  let totalPaid = 0;
  for (let i = 1; i <= 10; i++) {
    const amount = oldExtractAmount(props[`payment_${i}`]);
    if (amount != null) totalPaid += amount;
  }
  // The portal's own fallback: if nothing parsed, use total_amount_paid.
  if (!totalPaid) {
    const fallback = parseFloat(props.total_amount_paid);
    if (isFinite(fallback)) totalPaid = fallback;
  }
  const dealAmount = parseFloat(props.amount) || 0;
  return {
    dealAmount,
    totalPaid: round2(totalPaid),
    amountDue: round2(Math.max(0, dealAmount - totalPaid))
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// HubSpot reads
// ---------------------------------------------------------------------------
async function searchMultiDealContacts() {
  const out = [];
  let after;
  while (out.length < limit) {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "num_associated_deals", operator: "GT", value: "1" }] }],
        properties: ["email", "firstname", "lastname", "num_associated_deals"],
        limit: 100,
        ...(after ? { after } : {})
      })
    });
    if (!res.ok) throw new Error(`contact search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    out.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return out.slice(0, limit === Infinity ? undefined : limit);
}

async function dealsForContact(contactId) {
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers }
  );
  if (!assocRes.ok) return [];
  const assoc = await assocRes.json();
  const ids = (assoc.results || []).map(r => r.toObjectId).filter(Boolean).map(String);
  if (!ids.length) return [];

  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: ids.map(id => ({ id })), properties: [...DEAL_PROPERTIES] })
  });
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const contacts = await searchMultiDealContacts();
console.log(`Contacts with more than one deal: ${contacts.length}\n`);

const rows = [];
let changedDeal = 0;
let dueIncreased = 0;
let dueDecreased = 0;

for (const contact of contacts) {
  const email = contact.properties?.email || "";
  const name = `${contact.properties?.firstname || ""} ${contact.properties?.lastname || ""}`.trim();
  const deals = await dealsForContact(contact.id);
  if (!deals.length) continue;

  const before = oldSelection(deals);
  const beforeTotals = oldTotals(before);

  // No program context here: the report is portal-agnostic, so this shows the
  // classification-and-dedup effect on its own. Per-trip name matching can
  // only improve on it.
  const { enrolments } = buildEnrolments(deals);
  const after = enrolments[0];
  if (!after) continue;

  const afterPayments = parseDealPayments(after.properties);
  const { totalPaid: afterPaid, source } = totalPaidForDeal(after.properties, afterPayments);
  const afterAmount = Number.isFinite(after.amount) ? after.amount : 0;
  const afterDue = round2(Math.max(0, afterAmount - afterPaid));

  const dealChanged = String(before.id) !== String(after.id);
  const dueDelta = round2(afterDue - beforeTotals.amountDue);
  if (dealChanged) changedDeal++;
  if (dueDelta > 0.01) dueIncreased++;
  if (dueDelta < -0.01) dueDecreased++;

  rows.push({
    name,
    email,
    deals: deals.length,
    enrolments: enrolments.length,
    beforeDeal: before.properties?.dealname || before.id,
    afterDeal: after.name,
    dealChanged: dealChanged ? "YES" : "",
    beforeTotal: beforeTotals.dealAmount,
    afterTotal: afterAmount,
    beforePaid: beforeTotals.totalPaid,
    afterPaid,
    paidSource: source,
    beforeDue: beforeTotals.amountDue,
    afterDue,
    dueDelta
  });
}

// Most consequential first: the students whose balance goes up.
rows.sort((a, b) => b.dueDelta - a.dueDelta);

console.log(`Selected a different deal:      ${changedDeal}`);
console.log(`AMOUNT DUE goes UP:             ${dueIncreased}   <-- review these`);
console.log(`AMOUNT DUE goes DOWN:           ${dueDecreased}`);
console.log(`Unchanged:                      ${rows.length - dueIncreased - dueDecreased}\n`);

const notable = rows.filter(r => r.dealChanged || Math.abs(r.dueDelta) > 0.01);
console.log(`Notable rows (${notable.length}):\n`);
for (const r of notable.slice(0, 40)) {
  console.log(
    `${r.name || r.email}\n` +
    `   before: ${r.beforeDeal}  total ${money(r.beforeTotal)}  paid ${money(r.beforePaid)}  due ${money(r.beforeDue)}\n` +
    `   after:  ${r.afterDeal}  total ${money(r.afterTotal)}  paid ${money(r.afterPaid)}  due ${money(r.afterDue)}` +
    `   (${r.deals} deals -> ${r.enrolments} enrolments, paid from ${r.paidSource})\n`
  );
}
if (notable.length > 40) console.log(`... and ${notable.length - 40} more (use --csv for the full list)\n`);

if (csvPath) {
  const cols = Object.keys(rows[0] || {});
  const csv = [
    cols.join(","),
    ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))
  ].join("\n");
  writeFileSync(csvPath, csv, "utf-8");
  console.log(`Wrote ${rows.length} rows to ${csvPath}`);
}

function money(n) {
  return `$${(Number(n) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
