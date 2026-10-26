# Reading applications from pd-apply

New applications are made on **pd-apply** (apply.pacificdiscovery.org), not directly in Jotform. `netlify/functions/_shared/apply-source.js` merges them into every place this portal reads the application form:

- `lib/jotform.js` (application editor): `findSubmissionByEmail` includes them. `getSubmission` and `updateSubmission` route `pda_…` IDs to pd-apply, which mirrors edits to Jotform while its mirror is on.
- `get-application-data.js`, `get-uploaded-documents.js`, `get-fast-facts.js`: application-form reads include them.
- `get-students.js`: portrait photos.
- `document-proxy` (edge + Node fallback): also proxies photos stored on pd-apply, adding the service key server-side.

pd-apply returns applications in Jotform submission shape (same field IDs, labels and types), so nothing downstream changed. While the Jotform mirror is on, the mirrored Jotform copy is dropped in favour of the pd-apply one.

Env vars:

| Variable | |
|---|---|
| `APPLY_SERVICE_URL` | `https://apply.pacificdiscovery.org`. Leave unset to switch the adapter off. |
| `APPLY_SERVICE_KEY` | same secret as on pd-apply |
| `APPLY_FORM_IDS` | optional, default `240277257210046,251668678208874` |

If pd-apply is unreachable, the portal carries on with Jotform data only (a warning is logged). Test: `node tests/apply-source.test.mjs` (student) / `node test/apply-source.test.mjs` (instructor).

## Payment plans

Families who confirm their place on pd-apply's acceptance page choose a payment plan there (monthly, two instalments, in full, or balance later) and pd-apply charges it automatically.

- `get-paid-payments` adds `plan` for the selected deal (`GET /api/service/plan?dealId=&email=`; pd-apply only answers for the student or a parent on that application). `null` when there's no plan or pd-apply is unreachable.
- The Payments section shows **Your payment plan** (each payment and its status, the next charge) and hides the free-form *PAY NOW* and *custom amount* for those families — paying outside the plan would be charged again by it. The bank-transfer callout asks them to email admissions first (admissions can *Mark paid* a payment in the dashboard so it isn't charged).
- **Manage payments / Pay now** calls `payment-plan-link` (POST `{ dealId }`, deal ownership checked like `get-paid-payments`), which asks pd-apply for a fresh personal link and sends them to the acceptance page: pay a missed payment, pay the rest early, or change the card / bank account.

Test: `node tests/payment-plan.test.mjs`.
