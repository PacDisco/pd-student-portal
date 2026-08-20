// Parsing for the Deal `payment_1..10` properties.
//
// These are free-form strings maintained by hand and by two different
// upstream systems, so there are two shapes in production:
//
//   Format A (current) — positional, comma separated:
//     "250, pi_3U226DAY32Ud1Dlw30DY1se1, 2026-08-08"
//     "1750, Olivia Williams, 7 Aug 2026"
//     "1750"
//
//   Format B (legacy, 2025-era deals) — labelled, newline separated:
//     "Payment Reference - pi_3Rtwv3AY32Ud1Dlw18Jpc0u7,
//      Payment Type - Final Payment,
//      Payment Method - Credit Card,
//      Amount - USD $12500.00,
//      Surcharge - USD $437.50,
//      Total - USD $12,937.50"
//
// The previous single parser assumed format A and produced actively wrong
// numbers on format B: the "- " in "Amount - USD $250.00" survived the
// character strip so parseFloat saw "-250.00" and rejected it as
// non-positive, while "USD $12,937.50" split on its own thousands comma and
// yielded 937.50 instead of 12500. Dates fared worse — "Total - USD $8000"
// parsed as the year 8000.
//
// Rules that matter for money:
//   - Prefer `Amount` over `Total`. `Total` includes the 3.5% card
//     surcharge, so using it overstates what the student has paid against
//     their program balance. Fall back to `Total` only when `Amount` is
//     absent (mail-in payments carry no surcharge and only set `Total`).
//   - Never return a negative or zero amount; those are data errors, not
//     payments.

export const PAYMENT_FIELDS = Object.freeze(
  Array.from({ length: 10 }, (_, i) => `payment_${i + 1}`)
);

// Dates outside this window are data errors (a reference number or an
// amount that Date() happened to accept), not payment dates.
const MIN_YEAR = 2015;
const MAX_YEAR = 2035;

const FORMAT_B_KEYS = "payment reference|transaction id|payment type|payment method|amount|surcharge|total|currency";
const FORMAT_B_DETECT = new RegExp(`(?:^|[\\n,])\\s*(?:${FORMAT_B_KEYS})\\s*-\\s`, "i");

export function isLabelledFormat(raw) {
  return FORMAT_B_DETECT.test(String(raw || ""));
}

// ---------------------------------------------------------------------------
// money / date helpers
// ---------------------------------------------------------------------------

// Pulls a positive money value out of a labelled value like "USD $12,937.50".
// Strips currency words, symbols and thousands separators, then parses.
export function parseMoney(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// True when a *whole token* is a bare money value: "250", "$1,750", "8000.00".
// Deliberately strict — it must not match reference numbers such as
// "20260817I1B7031R003349" or "PD-0000000465".
const BARE_MONEY = /^\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\$?\d+(?:\.\d+)?$/;

export function looksLikeBareMoney(token) {
  return BARE_MONEY.test(String(token || "").trim());
}

export function looksLikeDate(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t)) return true;       // 2026-03-12
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(t)) return true;    // 22.2.26
  if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(t)) return true;
  return false;
}

// Parses a date token, returning null unless the result lands inside the
// plausible window. This is what keeps "USD $12" (year 2001) and
// "PD-0000000465" (year 465) out of the payment history.
export function parseFlexibleDate(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;

  const accept = (d) => {
    if (!d || isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    return y >= MIN_YEAR && y <= MAX_YEAR ? d : null;
  };

  // DD.MM.YY[YY] / DD/MM/YY[YY] — NZ order, checked before native Date()
  // because Date() reads "8/11/2026" as month-first.
  const m = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    let [, day, month, year] = m;
    if (year.length === 2) year = (parseInt(year, 10) > 50 ? "19" : "20") + year;
    const d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`);
    const ok = accept(d);
    if (ok) return ok;
  }

  // Only try native parsing on tokens that actually look like dates —
  // Date() is far too permissive to be handed arbitrary text.
  if (!looksLikeDate(trimmed)) return null;
  return accept(new Date(trimmed));
}

// ---------------------------------------------------------------------------
// entry parsing
// ---------------------------------------------------------------------------

function parseLabelledEntry(trimmed) {
  // Split on newlines, and on commas that immediately precede another
  // "Label - " pair (so "$12,937.50" is never split on its own comma).
  const parts = trimmed
    .split(new RegExp(`,?\\s*\\r?\\n|,(?=\\s*(?:${FORMAT_B_KEYS})\\s*-\\s)`, "i"))
    .map(s => s.trim())
    .filter(Boolean);

  const fields = {};
  for (const part of parts) {
    const m = part.match(/^([A-Za-z][A-Za-z ]*?)\s*-\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (!(key in fields)) fields[key] = m[2].trim();
  }

  const amount = parseMoney(fields["amount"]) ?? parseMoney(fields["total"]);
  const reference = fields["payment reference"] || fields["transaction id"] || null;
  const piMatch = trimmed.match(/pi_[A-Za-z0-9]+/);

  let dateRaw = null;
  let dateIso = null;
  for (const part of parts) {
    const d = parseFlexibleDate(part.replace(/^[A-Za-z][A-Za-z ]*?\s*-\s*/, ""));
    if (d) {
      dateRaw = part;
      dateIso = d.toISOString().slice(0, 10);
      break;
    }
  }

  return {
    raw: trimmed,
    format: "labelled",
    amount,
    // Surcharge is reported separately so the UI can show what was actually
    // charged without folding it into the program balance.
    surcharge: parseMoney(fields["surcharge"]),
    paymentType: fields["payment type"] || null,
    paymentMethod: fields["payment method"] || null,
    reference,
    stripePaymentIntent: piMatch ? piMatch[0] : null,
    dateRaw,
    dateIso
  };
}

function parsePositionalEntry(trimmed) {
  const piMatch = trimmed.match(/pi_[A-Za-z0-9]+/);
  const withoutPi = (piMatch ? trimmed.replace(piMatch[0], "") : trimmed)
    .replace(/,\s*,/g, ",");

  const tokens = withoutPi.split(",").map(s => s.trim()).filter(Boolean);

  // First token that is a bare money value. Strict matching means a bank
  // reference like "20260817I1B7031R003349" is never mistaken for one.
  let amount = null;
  for (const tok of tokens) {
    if (looksLikeDate(tok)) continue;
    if (!looksLikeBareMoney(tok)) continue;
    const n = parseMoney(tok);
    if (n != null) { amount = n; break; }
  }

  let dateRaw = null;
  let dateIso = null;
  for (const tok of [...tokens].reverse()) {
    const d = parseFlexibleDate(tok);
    if (d) { dateRaw = tok; dateIso = d.toISOString().slice(0, 10); break; }
  }

  // Whatever is left that is neither the amount nor the date is the
  // reference (a Stripe PI, a bank transaction id, or a payer name).
  const reference = tokens.find(t =>
    t !== dateRaw && !looksLikeBareMoney(t) && !looksLikeDate(t)
  ) || (piMatch ? piMatch[0] : null);

  return {
    raw: trimmed,
    format: "positional",
    amount,
    surcharge: null,
    paymentType: null,
    paymentMethod: null,
    reference,
    stripePaymentIntent: piMatch ? piMatch[0] : null,
    dateRaw,
    dateIso
  };
}

export function parsePaymentEntry(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isLabelledFormat(trimmed)
    ? parseLabelledEntry(trimmed)
    : parsePositionalEntry(trimmed);
}

// Parses every payment_N off a deal's properties, in schedule order.
export function parseDealPayments(properties = {}) {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const parsed = parsePaymentEntry(properties[`payment_${i}`]);
    if (parsed) out.push({ index: i, ...parsed });
  }
  return out;
}

// Total paid for a deal, from the parsed payment_N amounts and the deal's own
// `total_amount_paid`.
//
// Takes whichever is HIGHER rather than preferring the parsed sum outright.
// The schedule strings are hand-maintained and a single unparseable row (a
// free-text note like "Bank transfer received - see file") would otherwise
// understate what a student has paid — and understating paid means
// overstating AMOUNT DUE on a live PAY NOW link. Erring towards the larger
// figure fails safe: the worst case is a balance that looks smaller than it
// is, which the office notices, rather than billing someone twice.
//
// `source` records which figure won, and `discrepancy` flags the rows where
// they disagree — that is the list worth reconciling in HubSpot, and what the
// dry-run report surfaces.
export function totalPaidForDeal(properties = {}, payments = null) {
  const entries = payments || parseDealPayments(properties);
  const summed = round2(entries.reduce((acc, e) => acc + (Number(e.amount) || 0), 0));

  const declaredRaw = parseFloat(properties.total_amount_paid);
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? round2(declaredRaw) : 0;

  if (!summed && !declared) return { totalPaid: 0, source: "none", discrepancy: false };

  // An unparsed row is likely whenever the deal lists more schedule entries
  // than we managed to read an amount from.
  const unreadable = entries.some(e => e.amount == null);
  const discrepancy = Boolean(summed && declared && Math.abs(summed - declared) > 0.01);

  if (declared > summed) {
    return { totalPaid: declared, source: "total_amount_paid", discrepancy, unreadable };
  }
  return { totalPaid: summed, source: "payments", discrepancy, unreadable };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
