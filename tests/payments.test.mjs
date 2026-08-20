// Unit tests for the payment_N parsing in _shared/payments.js.
// Run with:  node tests/payments.test.mjs
//
// This file MUST stay outside netlify/functions/. Netlify treats every file in
// that directory as a deployable function, and a name containing ".test" is an
// illegal function name — it fails the entire build.
//
// Every fixture below is a real string taken from a live Pacific Discovery
// deal, not an invented example. The two formats coexist in production: the
// positional one on current deals, the labelled one on 2025-era deals.

import assert from "node:assert/strict";
import {
  parsePaymentEntry,
  parseDealPayments,
  totalPaidForDeal,
  isLabelledFormat,
  parseFlexibleDate,
  looksLikeBareMoney
} from "../netlify/functions/_shared/payments.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// --- format detection -------------------------------------------------------

test("detects the labelled format", () => {
  assert.equal(isLabelledFormat("Payment Reference - PD-0000000465,\nAmount - USD $500.00"), true);
  assert.equal(isLabelledFormat("250, pi_3U226DAY32Ud1Dlw30DY1se1, 2026-08-08"), false);
  assert.equal(isLabelledFormat("1750"), false);
});

// --- positional format (current deals) --------------------------------------

test("positional: amount, stripe PI, ISO date", () => {
  const r = parsePaymentEntry("250, pi_3U226DAY32Ud1Dlw30DY1se1, 2026-08-08");
  assert.equal(r.amount, 250);
  assert.equal(r.stripePaymentIntent, "pi_3U226DAY32Ud1Dlw30DY1se1");
  assert.equal(r.dateIso, "2026-08-08");
});

test("positional: bank reference is not mistaken for the amount", () => {
  // The middle token is a 22-character bank transaction id beginning with a
  // date-like run of digits. The old parser's character-strip approach would
  // happily turn it into a number.
  const r = parsePaymentEntry("1950, 20260817I1B7031R003349, 2026-08-17");
  assert.equal(r.amount, 1950);
  assert.equal(r.reference, "20260817I1B7031R003349");
  assert.equal(r.dateIso, "2026-08-17");
});

test("positional: large amount with a long-form date", () => {
  const r = parsePaymentEntry("1750, pi_3U4xOlDaC93fmk9l3ZkaWakz, 16 Aug 2026");
  assert.equal(r.amount, 1750);
  assert.equal(r.dateIso, "2026-08-16");
});

test("positional: payer name in the reference slot", () => {
  const r = parsePaymentEntry("1750, Olivia Williams, 7 Aug 2026");
  assert.equal(r.amount, 1750);
  assert.equal(r.reference, "Olivia Williams");
  assert.equal(r.dateIso, "2026-08-07");
});

test("positional: amount only", () => {
  const r = parsePaymentEntry("1750");
  assert.equal(r.amount, 1750);
  assert.equal(r.dateIso, null);
});

test("positional: NZ-order day-first date", () => {
  const r = parsePaymentEntry("500, , 22.2.26");
  assert.equal(r.amount, 500);
  assert.equal(r.dateIso, "2026-02-22");
});

// --- labelled format (2025-era deals) ---------------------------------------

test("labelled: uses Amount, not the surcharge-inclusive Total", () => {
  // Regression: the thousands comma in "$12,937.50" used to split the entry
  // and yield 937.50 as the payment amount.
  const r = parsePaymentEntry(
    "Payment Reference - pi_3Rtwv3AY32Ud1Dlw18Jpc0u7,\n" +
    "Payment Type - Final Payment,\n" +
    "Payment Method - Credit Card,\n" +
    "Amount - USD $12500.00,\n" +
    "Surcharge - USD $437.50,\n" +
    "Total - USD $12,937.50\n"
  );
  assert.equal(r.amount, 12500);
  assert.equal(r.surcharge, 437.5);
  assert.equal(r.paymentType, "Final Payment");
  assert.equal(r.stripePaymentIntent, "pi_3Rtwv3AY32Ud1Dlw18Jpc0u7");
});

test("labelled: application fee is no longer dropped", () => {
  // Regression: "Amount - USD $250.00" left a leading hyphen after the old
  // character strip, so parseFloat produced -250 and the n > 0 test rejected
  // it — every labelled entry came back with a null amount.
  const r = parsePaymentEntry(
    "Payment Reference - pi_3RikkoAY32Ud1Dlw3nFRW2Bx,\n" +
    "Payment Type - Application Fee,\n" +
    "Payment Method - Credit Card,\n" +
    "Amount - USD $250.00,\n" +
    "Surcharge - USD $8.75,\n" +
    "Total - USD $258.75\n"
  );
  assert.equal(r.amount, 250);
  assert.equal(r.surcharge, 8.75);
});

test("labelled: falls back to Total when there is no Amount", () => {
  // Mail-in payments carry no surcharge, so Total is the real figure.
  const r = parsePaymentEntry(
    "Payment Reference - PD-0000000499,\n" +
    "Payment Type - Deposit,\n" +
    "Payment Method - Mail In,\n" +
    "Total - USD $8000"
  );
  assert.equal(r.amount, 8000);
  assert.equal(r.paymentMethod, "Mail In");
  assert.equal(r.reference, "PD-0000000499");
});

test("labelled: a reference number never becomes a date", () => {
  // Regressions: "PD-0000000465" parsed as the year 465, and
  // "Total - USD $8000" as the year 8000.
  const a = parsePaymentEntry(
    "Payment Reference - PD-0000000465,\n" +
    "Transaction ID - 0000000865de70b9,\n" +
    "Payment Type - Application Fee,\n" +
    "Amount - USD $500.00,\n" +
    "Total - USD $517.50"
  );
  assert.equal(a.amount, 500);
  assert.equal(a.dateIso, null);

  const b = parsePaymentEntry(
    "Payment Reference - PD-0000000499,\nPayment Type - Deposit,\nTotal - USD $8000"
  );
  assert.equal(b.dateIso, null);
});

// --- date plausibility ------------------------------------------------------

test("rejects implausible dates outright", () => {
  assert.equal(parseFlexibleDate("USD $12"), null);
  assert.equal(parseFlexibleDate("PD-0000000465"), null);
  assert.equal(parseFlexibleDate("1999-01-01"), null);   // before the window
  assert.equal(parseFlexibleDate("2040-01-01"), null);   // after the window
  assert.notEqual(parseFlexibleDate("2026-08-08"), null);
});

test("bare-money matching is strict", () => {
  assert.equal(looksLikeBareMoney("1750"), true);
  assert.equal(looksLikeBareMoney("$12,937.50"), true);
  assert.equal(looksLikeBareMoney("20260817I1B7031R003349"), false);
  assert.equal(looksLikeBareMoney("PD-0000000465"), false);
  assert.equal(looksLikeBareMoney("Olivia Williams"), false);
});

// --- deal-level totals ------------------------------------------------------

test("sums a deal's payments in schedule order", () => {
  // Jonas Fritzsche's program deal: $250 then $16,250 against a $16,500 deal.
  const props = {
    amount: "16500",
    payment_1: "250, pi_3U226DAY32Ud1Dlw30DY1se1, 2026-08-08",
    payment_2: "16250, 20260817I1B7031R003349, 2026-08-18"
  };
  const parsed = parseDealPayments(props);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(p => p.index), [1, 2]);

  const { totalPaid, source } = totalPaidForDeal(props, parsed);
  assert.equal(totalPaid, 16500);
  assert.equal(source, "payments");
});

test("falls back to total_amount_paid when nothing parses", () => {
  const { totalPaid, source } = totalPaidForDeal({ amount: "1950", total_amount_paid: "1950" });
  assert.equal(totalPaid, 1950);
  assert.equal(source, "total_amount_paid");
});

test("an unparseable schedule row cannot understate what a student has paid", () => {
  // The rows are hand-maintained, and free-text notes appear among them. If a
  // partial parse won, a fully-paid student would be shown a $16,250 balance
  // with a live PAY NOW link. Take the higher figure and flag the mismatch.
  const props = {
    amount: "16500",
    total_amount_paid: "16500",
    payment_1: "250, pi_x, 2026-08-08",
    payment_2: "Bank transfer received - see file"
  };
  const { totalPaid, source, discrepancy } = totalPaidForDeal(props);
  assert.equal(totalPaid, 16500);
  assert.equal(source, "total_amount_paid");
  assert.equal(discrepancy, true, "worth reconciling in HubSpot");
});

test("a parsed sum above a stale total_amount_paid still wins", () => {
  const props = {
    amount: "16500",
    total_amount_paid: "250",
    payment_1: "250, pi_x, 2026-08-08",
    payment_2: "16250, ref, 2026-08-18"
  };
  const { totalPaid, source } = totalPaidForDeal(props);
  assert.equal(totalPaid, 16500);
  assert.equal(source, "payments");
});

test("reports zero rather than guessing when there is nothing to go on", () => {
  const { totalPaid, source } = totalPaidForDeal({ amount: "11500" });
  assert.equal(totalPaid, 0);
  assert.equal(source, "none");
});

test("ignores blank and malformed entries", () => {
  assert.equal(parsePaymentEntry(""), null);
  assert.equal(parsePaymentEntry("   "), null);
  assert.equal(parsePaymentEntry(null), null);
  assert.equal(parsePaymentEntry(undefined), null);
  assert.equal(parsePaymentEntry("n/a").amount, null);
});

if (!process.exitCode) console.log(`payments.test.mjs — ${passed} passed`);
