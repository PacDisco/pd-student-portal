// node <tests dir>/portal-phase.test.mjs — the admin program picker's phases (get-portals describePortal).
import assert from "node:assert/strict";
import { describePortal } from "../netlify/functions/get-portals.js";

const now = new Date("2026-11-11T00:00:00Z");
const d = (p) => describePortal(p, { now });
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ✓", name); };

t("completed from the day after program_end_date", () => {
  assert.equal(d({ program_start_date: "2026-07-02", program_end_date: "2026-07-29" }).phase, "completed");
  assert.equal(d({ program_start_date: "2026-09-10", program_end_date: "2026-11-11" }).phase, "in-progress", "still running on its last day");
  assert.equal(d({ program_start_date: "2026-09-10", program_end_date: "2026-11-18" }).phase, "in-progress");
  assert.equal(d({ program_start_date: "2027-02-11", program_end_date: "2027-04-21" }).phase, "upcoming");
  assert.equal(d({ program_start_date: "1783900800000" }).start, "2026-07-13", "epoch milliseconds too");
});
t("no end date: 30 days after the start; no dates: the year in the name", () => {
  assert.equal(d({ program_start_date: "2026-09-01" }).phase, "completed");
  assert.equal(d({ program_start_date: "2027-02-11" }).phase, "upcoming");
  assert.equal(d({ pacific_discovery_program: "2025 Bali Summer Program" }).phase, "completed");
  assert.equal(d({ pacific_discovery_program: "2027 Bali Summer Program" }).phase, "no-dates");
});
t("destination and term for the filters", () => {
  const a = d({ program_name: "2027 Australia & Bali Spring Semester Program", program_start_date: "2027-02-11" });
  assert.equal(a.country, "Australia & Bali"); assert.equal(a.term, "Spring"); assert.equal(a.year, 2027);
  assert.equal(d({ program_name: "Polynesian Journey Fall 2026" }).country, "Polynesian Journey");
  assert.equal(d({ pacific_discovery_program: "2027 Hawaii Fall Mini Semester" }).country, "Hawaii");
  assert.equal(d({ program_name: "New Zealand & Fiji Summer Program" }).term, "Summer");
  assert.equal(d({ program_name: "Somewhere", program_start_date: "2027-06-20" }).term, "Summer", "term from the start month");
  assert.equal(d({ program_name: "test program" }).country, "");
});
t("a Status of Completed / Cancelled closes it early", () => {
  assert.equal(d({ status: "Cancelled", program_start_date: "2027-02-11" }).completed, true);
});
console.log(`${n} passed`);
