// Unit tests for the enrolment resolver in _shared/deal.js.
// Run with:  node tests/deal.test.mjs
//
// Must stay outside netlify/functions/ — see the note in payments.test.mjs.
//
// The fixtures are real deal shapes from the Pacific Discovery HubSpot
// portal. They cover the three ways a contact ends up with several deals:
// an add-on alongside a program, accidental duplicates from a workflow
// double-firing, and genuinely separate programs.

import assert from "node:assert/strict";
import {
  buildEnrolments,
  pickEnrolment,
  classifyDeal,
  dedupeKey,
  nameOverlap,
  programPartOfName,
  isStaleShell,
  isCancelled,
  isMarkedDead,
  programNameOfDeal,
  withinDuplicateWindow,
  toClientEnrolment
} from "../netlify/functions/_shared/deal.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const deal = (id, properties) => ({ id: String(id), properties });

// --- real fixtures ----------------------------------------------------------

// Jonas Fritzsche: paid his $16,500 semester in full; a $1,950 College
// Credits deal was created 17 hours later and so used to win on recency.
const JONAS_ADDON = deal(63574332796, {
  dealname: "Jonas - College Credits ",
  amount: "1950",
  pipeline: "74958084",
  pd_program: "College Credit Program",
  createdate: "2026-08-07T20:22:43.397Z",
  payment_1: "1950, 20260817I1B7031R003349, 2026-08-17"
});
const JONAS_PROGRAM = deal(63553957534, {
  dealname: "Jonas Fritzsche - New Zealand and Australia Gap Semester",
  amount: "16500",
  pipeline: "74958084",
  pd_program: "New Zealand & Australia Semester",
  // He bought college credit alongside the semester. This must NOT make the
  // semester itself look like an add-on.
  college_credit: "Yes",
  createdate: "2026-08-07T03:03:40.231Z",
  document_submissions: "Waiver;Insurance Information;College Credit Application",
  payment_1: "250, pi_3U226DAY32Ud1Dlw30DY1se1, 2026-08-08",
  payment_2: "16250, 20260817I1B7031R003349, 2026-08-18"
});

// Somya Raikwar: the same deal created three times inside 100 minutes, plus
// one sitting in the Test PD Pipeline.
const SOMYA_DUPES = [
  deal(39536739098, { dealname: "Somya Raikwar - New Zealand and Australia Gap Semester", amount: "16500", pipeline: "742406417", createdate: "2025-07-01T01:29:44.760Z" }),
  deal(39526309546, { dealname: "Somya Raikwar - New Zealand and Australia Gap Semester", amount: "16500", pipeline: "742406417", createdate: "2025-07-01T00:03:23.615Z", payment_1: "250, pi_x, 2025-07-02" }),
  deal(39531857506, { dealname: "Somya Raikwar - New Zealand and Australia Gap Semester", amount: "16500", pipeline: "742406417", createdate: "2025-06-30T23:49:15.343Z" })
];
const SOMYA_TEST_PIPELINE = deal(39503311134, {
  dealname: "New Zealand & Australia Semester",
  amount: "16500",
  pipeline: "12030850",
  createdate: "2025-06-30T12:36:23.349Z"
});

// Raphael Vieira: two genuinely different Hawaii programs.
const RAPHAEL_MINI = deal(60260610839, {
  dealname: "raphael vieira - Hawaii Mini Semester",
  amount: "11500",
  pipeline: "742406417",
  createdate: "2026-05-15T03:38:43.497Z",
  document_submissions: "Passport;Insurance Information;Flight Information;Bio Complete"
});
const RAPHAEL_SUMMER = deal(56885642060, {
  dealname: "raphael vieira - Hawaii Summer Program",
  amount: "8950",
  pipeline: "742406417",
  createdate: "2026-02-23T16:04:05.249Z"
});

// Kaden Farrell: an abandoned $0 shell with nothing on it.
const STALE_SHELL = deal(19990313655, {
  dealname: "Kaden Farrell - SEA",
  amount: "0",
  pipeline: "74958084",
  createdate: "2024-06-10T19:10:06.764Z"
});

// --- classification ---------------------------------------------------------

test("PD Program decides that a College Credit deal is an add-on", () => {
  // The rule that matters: pd_program = "College Credit Program" means no
  // application-fee or deposit buttons, whatever the deal is called.
  assert.equal(classifyDeal(JONAS_ADDON), "addon");
  assert.equal(classifyDeal(deal(1, {
    dealname: "Anything at all", amount: "1950", pd_program: "College Credit Program"
  })), "addon");
  assert.equal(classifyDeal(deal(2, {
    dealname: "Devin Bright - Whatever", amount: "799", pd_program: "Basecamp"
  })), "addon");
});

test("PD Program also decides that a deal IS a program", () => {
  // Jonas's semester carries college_credit = "Yes". Ordering matters: the
  // enumeration is authoritative, so the semester stays a program and keeps
  // its deposit staging.
  assert.equal(classifyDeal(JONAS_PROGRAM), "program");
  // A program whose NAME would trip the add-on pattern is still a program
  // when pd_program says so.
  assert.equal(classifyDeal(deal(3, {
    dealname: "Someone - Semester incl College Credit",
    amount: "16500",
    pd_program: "South America Semester"
  })), "program");
});

test("falls back to the deal name when PD Program is empty", () => {
  // One real add-on (Eva Norton, 2024) has no pd_program, and about three in
  // four program deals don't either — so the name fallback has to stay.
  assert.equal(classifyDeal(deal(28870918718, {
    dealname: "Eva Norton - College Credit", amount: "1950"
  })), "addon");
  assert.equal(classifyDeal(deal(4, {
    dealname: "Avery Brophy - Costa Rica Mini Semester", amount: "9500"
  })), "program");
});

test("pd_program marked Dropped is not selectable, unless money was paid", () => {
  const dropped = deal(5, {
    dealname: "Someone - Hawaii Semester", amount: "11500", pd_program: "Dropped"
  });
  assert.equal(isMarkedDead(dropped.properties), true);
  assert.equal(classifyDeal(dropped), "ignore");

  const droppedButPaid = deal(6, {
    dealname: "Someone - Hawaii Semester", amount: "11500", pd_program: "Dropped",
    payment_1: "250, pi_a, 2026-01-05"
  });
  assert.equal(isMarkedDead(droppedButPaid.properties), false,
    "they paid — they must be able to see it and chase the refund");
  assert.equal(classifyDeal(droppedButPaid), "program");
});

test("a CANCELLATION intake is not selectable", () => {
  const d = deal(7, {
    dealname: "Someone - Thailand Mini Semester", amount: "10500",
    pd_program: "Thailand Mini Semester", program_intake: "CANCELLATION"
  });
  assert.equal(classifyDeal(d), "ignore");
});

test("uses PD Program as the switcher label when present", () => {
  assert.equal(programNameOfDeal(JONAS_ADDON.properties), "College Credit Program");
  assert.equal(programNameOfDeal(JONAS_PROGRAM.properties), "New Zealand & Australia Semester");
  // No pd_program — fall back to the part after the student's name.
  assert.equal(programNameOfDeal({ dealname: "Avery Brophy - Costa Rica Mini Semester" }),
    "Costa Rica Mini Semester");
});

test("an exact PD Program match outranks a partial name match", () => {
  const exact = deal(8, {
    dealname: "Someone - unhelpful name", amount: "9999", pipeline: "742406417",
    pd_program: "Hawaii Mini Semester", createdate: "2020-01-01T00:00:00Z"
  });
  const { enrolments } = buildEnrolments([RAPHAEL_SUMMER, exact], {
    programName: "Hawaii Mini Semester"
  });
  assert.equal(pickEnrolment(enrolments, null).id, "8");
});

test("classifies a program deal as a program", () => {
  assert.equal(classifyDeal(JONAS_PROGRAM), "program");
});

test("ignores test-pipeline and abandoned deals", () => {
  assert.equal(classifyDeal(SOMYA_TEST_PIPELINE), "ignore");
  assert.equal(classifyDeal(STALE_SHELL), "ignore");
  assert.equal(isStaleShell(STALE_SHELL.properties), true);
});

test("an explicit portal_deal_role overrides the name heuristic", () => {
  const d = deal(2, { dealname: "Someone - College Credits", amount: "1950", portal_deal_role: "program" });
  assert.equal(classifyDeal(d), "program");
});

test("a deal with no amount but real documents is not stale", () => {
  // Emilly Vanira's deals carry no `amount` at all, but they do carry a
  // document checklist — they are live enrolments, not shells.
  const props = { dealname: "Emilly Vanira - Australia and Bali Gap Semester", document_submissions: "Passport;Bio Complete" };
  assert.equal(isStaleShell(props), false);
});

// --- name handling ----------------------------------------------------------

test("extracts the program part of a deal name", () => {
  assert.equal(programPartOfName("Jonas Fritzsche - New Zealand and Australia Gap Semester"), "New Zealand and Australia Gap Semester");
  assert.equal(programPartOfName("Rachel Stern"), "Rachel Stern");
  assert.equal(programPartOfName("KeenanBhansali"), "KeenanBhansali");
});

test("matches program names across & / and and casing", () => {
  assert.equal(nameOverlap("Justin Toothaker - New Zealand & Australia Semester", "New Zealand and Australia Gap Semester"), 1);
  assert.equal(nameOverlap("raphael vieira - Hawaii Summer Program", "Hawaii Mini Semester"), 0.5);
  assert.equal(nameOverlap("Liam Ott - New Deal", "South America Gap Semester"), 0);
});

// --- duplicate collapsing ---------------------------------------------------

test("collapses identical duplicates to one enrolment", () => {
  const { enrolments } = buildEnrolments(SOMYA_DUPES.concat([SOMYA_TEST_PIPELINE]));
  assert.equal(enrolments.length, 1, "three duplicates plus a test-pipeline deal should yield one enrolment");
  // The survivor is the one the office actually worked on (it has a payment).
  assert.equal(enrolments[0].id, "39526309546");
  assert.deepEqual(enrolments[0].mergedIds.sort(), ["39531857506", "39536739098"]);
});

test("duplicate keys ignore createdate", () => {
  assert.equal(dedupeKey(SOMYA_DUPES[0]), dedupeKey(SOMYA_DUPES[1]));
  assert.notEqual(dedupeKey(RAPHAEL_MINI), dedupeKey(RAPHAEL_SUMMER));
});

// --- selection --------------------------------------------------------------

test("prefers the program deal over a newer add-on", () => {
  // The regression this whole change exists for: Jonas's add-on is newer, so
  // the old newest-createdate rule showed his $1,950 college credit as his
  // program total and offered him a deposit button.
  const { enrolments } = buildEnrolments([JONAS_ADDON, JONAS_PROGRAM]);
  const selected = pickEnrolment(enrolments, null);
  assert.equal(selected.id, "63553957534");
  assert.equal(selected.kind, "program");
  assert.equal(selected.amount, 16500);
  assert.equal(selected.totalPaid, 16500);
  assert.equal(selected.amountDue, 0);
});

test("keeps the add-on available to switch to", () => {
  const { enrolments } = buildEnrolments([JONAS_ADDON, JONAS_PROGRAM]);
  assert.equal(enrolments.length, 2);
  assert.deepEqual(enrolments.map(e => e.kind), ["program", "addon"]);
  const addon = enrolments.find(e => e.kind === "addon");
  assert.equal(addon.amount, 1950);
  assert.equal(addon.totalPaid, 1950);
});

test("scores a program deal against the trip being viewed", () => {
  // Same two Hawaii programs, two different trips — the selection follows
  // the trip rather than recency.
  const summerFirst = buildEnrolments([RAPHAEL_MINI, RAPHAEL_SUMMER], {
    programName: "Hawaii Summer Program",
    programTuition: "8950"
  });
  assert.equal(pickEnrolment(summerFirst.enrolments, null).id, "56885642060");

  const miniFirst = buildEnrolments([RAPHAEL_MINI, RAPHAEL_SUMMER], {
    programName: "Hawaii Mini Semester",
    programTuition: "11500"
  });
  assert.equal(pickEnrolment(miniFirst.enrolments, null).id, "60260610839");
});

test("portal_program_id beats every other signal", () => {
  const linked = deal(999, {
    dealname: "Someone - Unrelated Name",
    amount: "1",
    pipeline: "742406417",
    createdate: "2020-01-01T00:00:00Z",
    portal_program_id: "54796059999"
  });
  const { enrolments } = buildEnrolments([RAPHAEL_MINI, linked], {
    portalId: "54796059999",
    programName: "Hawaii Mini Semester"
  });
  assert.equal(pickEnrolment(enrolments, null).id, "999");
});

test("falls back to recency only among equally-plausible programs", () => {
  const { enrolments } = buildEnrolments([RAPHAEL_SUMMER, RAPHAEL_MINI]);
  assert.equal(pickEnrolment(enrolments, null).id, "60260610839", "newest of two unranked programs");
});

test("honours an explicit choice", () => {
  const { enrolments } = buildEnrolments([JONAS_ADDON, JONAS_PROGRAM]);
  assert.equal(pickEnrolment(enrolments, "63574332796").id, "63574332796");
});

test("a request for a collapsed duplicate resolves to its survivor", () => {
  const { enrolments } = buildEnrolments(SOMYA_DUPES);
  const selected = pickEnrolment(enrolments, "39536739098"); // a merged id
  assert.equal(selected.id, "39526309546");
});

test("an unknown deal id falls back to the default rather than failing", () => {
  const { enrolments } = buildEnrolments([JONAS_ADDON, JONAS_PROGRAM]);
  assert.equal(pickEnrolment(enrolments, "not-a-real-id").id, "63553957534");
});

test("handles a contact with no deals", () => {
  const { enrolments } = buildEnrolments([]);
  assert.deepEqual(enrolments, []);
  assert.equal(pickEnrolment(enrolments, null), null);
});

// --- client payload ---------------------------------------------------------

test("the client payload carries no raw HubSpot properties", () => {
  const { enrolments } = buildEnrolments([JONAS_ADDON, JONAS_PROGRAM]);
  const selected = pickEnrolment(enrolments, null);
  const client = toClientEnrolment(selected, selected.id);
  assert.deepEqual(
    Object.keys(client).sort(),
    ["amount", "amountDue", "id", "kind", "label", "name", "pdProgram", "selected", "totalPaid"]
  );
  assert.equal(client.selected, true);
  assert.equal(client.label, "New Zealand & Australia Semester");
});

// --- duplicate window ------------------------------------------------------

test("the same program bought again years later is NOT a duplicate", () => {
  // Rachel Stern has enrolled three times across 2023-2026. Two enrolments on
  // the same program at the same price must stay separate enrolments —
  // collapsing them would hide the older one and its payment history behind
  // the newer, and the switcher would never appear.
  const older = deal(101, {
    dealname: "Rachel Stern - Costa Rica Mini Semester",
    amount: "8500", pipeline: "742406417",
    createdate: "2024-03-01T00:00:00Z",
    total_amount_paid: "8500"
  });
  const newer = deal(202, {
    dealname: "Rachel Stern - Costa Rica Mini Semester",
    amount: "8500", pipeline: "742406417",
    createdate: "2026-03-01T00:00:00Z",
    payment_1: "250, pi_z, 2026-03-02"
  });
  const { enrolments } = buildEnrolments([older, newer]);
  assert.equal(enrolments.length, 2, "two years apart is not a double-fire");
  assert.deepEqual(enrolments.map(e => e.id).sort(), ["101", "202"]);
  assert.equal(withinDuplicateWindow(older, newer), false);
  assert.equal(withinDuplicateWindow(SOMYA_DUPES[0], SOMYA_DUPES[1]), true);
});

// --- cancelled enrolments ---------------------------------------------------

test("a closed-lost deal with nothing paid is not selectable", () => {
  // Jocelyn Glennie's "Cancelled" deal — before the switcher it was
  // unreachable; exposing it would put a live PAY NOW link on $11,500 for a
  // trip she is not going on.
  const cancelled = deal(8988801870, {
    dealname: "Jocelyn Glennie - Cancelled",
    amount: "11500", pipeline: "74958084",
    createdate: "2022-01-01T00:00:00Z",
    hs_is_closed: "true", hs_is_closed_won: "false"
  });
  assert.equal(classifyDeal(cancelled), "ignore");
  assert.equal(isCancelled(cancelled.properties), true);

  const { enrolments } = buildEnrolments([cancelled, JONAS_PROGRAM]);
  assert.equal(enrolments.length, 1);
  assert.equal(enrolments[0].id, "63553957534");
});

test("a closed-WON past program stays selectable", () => {
  // An alumnus looking back at a fully-paid program is a legitimate case.
  const won = deal(39863283789, {
    dealname: "Liam Ott - South America Gap Semester",
    amount: "15000", pipeline: "74958084",
    createdate: "2025-07-08T23:14:02.238Z",
    hs_is_closed: "true", hs_is_closed_won: "true",
    total_amount_paid: "15000"
  });
  assert.equal(classifyDeal(won), "program");
  assert.equal(isCancelled(won.properties), false);
});

test("a closed-lost deal that was partly paid stays visible", () => {
  // Money changed hands, so the student needs to be able to see it (and chase
  // a refund) — hiding it would hide their own payment history.
  const partly = deal(777, {
    dealname: "Someone - South America Gap Semester",
    amount: "15000", pipeline: "74958084",
    createdate: "2025-01-01T00:00:00Z",
    hs_is_closed: "true", hs_is_closed_won: "false",
    payment_1: "250, pi_q, 2025-01-02"
  });
  assert.equal(isCancelled(partly.properties), false);
  assert.equal(classifyDeal(partly), "program");
});

test("the salvage fallback does not mislabel an ignored deal as a program", () => {
  const { enrolments } = buildEnrolments([STALE_SHELL, SOMYA_TEST_PIPELINE]);
  assert.ok(enrolments.length > 0, "an empty portal is worse than a thin one");
  assert.ok(enrolments.every(e => e.kind === "other"),
    "a test-pipeline or abandoned record must not render as PROGRAM TOTAL");
});

if (!process.exitCode) console.log(`deal.test.mjs — ${passed} passed`);
