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
