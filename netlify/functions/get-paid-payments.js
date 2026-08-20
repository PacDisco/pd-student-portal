// Returns the payment schedule for ONE of the logged-in student's
// enrolments, plus the list of every enrolment they can switch between.
//
// A contact often has more than one Deal — a program deal plus a College
// Credit or Basecamp add-on, or two programs in different semesters. This
// endpoint used to take whichever deal was created most recently, which is
// usually the add-on, so a student who had paid their program in full saw
// the add-on's $1,950 as their program total and was offered a deposit
// button. Deal selection now lives in _shared/deal.js and the student
// chooses via `?dealId=`.
//
// Inputs (querystring, all optional):
//   dealId          — the enrolment to render. Validated against the
//                     contact's own deal associations before it is honoured.
//   programName     — program_name from the Program record being viewed.
//   programTuition  — program_tuition, likewise.
//   portalId        — Program record id, matched against the deal's
//                     portal_program_id when that property is populated.
//                     These three are ranking hints only; they never widen
//                     what the caller is allowed to see.
//
// Returns:
//   {
//     dealId, dealName, dealKind,
//     dealAmount,            // the deal's `amount` — the program total
//     totalAmountPaid,       // the deal's own total_amount_paid, if set
//     totalPaid,             // parsed sum, with total_amount_paid fallback
//     totalPaidSource,       // "payments" | "total_amount_paid" | "none"
//     payments: [...],       // parsed payment_1..10, in schedule order
//     enrolments: [...]      // for the switcher
//   }
//
// The payment_N parsing itself lives in _shared/payments.js, which handles
// both production formats (see the note at the top of that file).

import { authenticate, authError } from "./_shared/auth.js";
import { resolveEnrolmentsForEmail, toClientEnrolment } from "./_shared/deal.js";

const json = (statusCode, payload) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

export async function handler(event) {
  try {
    // Email from the verified token — a user only sees their own payments.
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }

    if (!process.env.HUBSPOT_API_KEY) {
      return json(500, { error: "HUBSPOT_API_KEY is not set" });
    }

    const params = event.queryStringParameters || {};

    let resolved;
    try {
      resolved = await resolveEnrolmentsForEmail(identity.email, {
        requestedDealId: params.dealId,
        program: {
          portalId: params.portalId,
          programName: params.programName,
          programTuition: params.programTuition
        }
      });
    } catch (err) {
      return json(502, { error: err.message, details: err.details });
    }

    if (!resolved.contactId) {
      return json(404, { error: "Contact not found" });
    }

    const { enrolments, selected } = resolved;
    if (!selected) {
      return json(200, {
        payments: [],
        enrolments: [],
        reason: "Contact has no deals"
      });
    }

    return json(200, {
      dealId: selected.id,
      dealName: selected.name,
      dealKind: selected.kind,
      dealAmount: selected.amount,
      totalAmountPaid: selected.properties?.total_amount_paid ?? null,
      totalPaid: selected.totalPaid,
      totalPaidSource: selected.totalPaidSource,
      amountDue: selected.amountDue,
      payments: selected.payments.map(p => ({
        index: p.index,
        amount: p.amount,
        surcharge: p.surcharge,
        paymentType: p.paymentType,
        paymentMethod: p.paymentMethod,
        reference: p.reference,
        stripePaymentIntent: p.stripePaymentIntent,
        dateRaw: p.dateRaw,
        dateIso: p.dateIso
      })),
      enrolments: enrolments.map(e => toClientEnrolment(e, selected.id)),
      // True when the client asked for a specific deal and got it. Lets the
      // UI tell "you chose this" from "we picked this for you".
      dealRequested: resolved.requestHonoured
    });

  } catch (err) {
    console.error("[get-paid-payments]", err?.stack || err?.message || err);
    return json(500, { error: err.message || "Server error" });
  }
}
