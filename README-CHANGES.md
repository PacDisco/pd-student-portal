# Enrolment switcher — what changed

Built 19 Aug 2026. Apply with `git apply deal-selection.patch` from the repo root (verified against a clean copy of the zip you sent). 11 files, +2217/−430.

**Updated** to classify on the Deal's **PD Program** (`pd_program`) rather than the deal name, per your note.

Both cases you described are covered by one mechanism: the server resolves a list of **enrolments** for the logged-in contact, and the Payments and Document Uploads tabs are scoped to whichever one is selected. A dropdown appears above both panels when there's more than one. Trip content — itinerary, flights, manuals, message board — doesn't re-scope, since a College Credit deal has no trip of its own.

## Behaviour, using Jonas Fritzsche's real records

He has a $16,500 semester (paid in full) and a $1,950 College Credits deal created 17 hours later.

| | Before | After |
|---|---|---|
| Program total | $1,950 | $16,500 |
| Amount paid | $1,950 | $16,500 |
| Amount due | $0 | $0 |
| Buttons | **PAY REMAINING DEPOSIT $550** | none |
| Payment history | one $1,950 row | $250 and $16,250 |
| Document checklist | all green | Waiver, Insurance Information, College Credit Application outstanding |
| College credits | unreachable | second option in the dropdown |

Switching to the College Credits option shows $1,950 / $1,950 / $0 with no deposit buttons. And on an *unpaid* college credit deal — the worse case — it now offers only its own $1,950 balance, where before it staged "PAY APPLICATION FEE $258.75" and "PAY DEPOSIT $2,328.75" against a $1,950 item.

Rachel Stern (three enrolments, 2023 / 2024 / 2026) gets all three in the dropdown, most relevant first. Somya Raikwar's three duplicate $16,500 records collapse to one, silently — nobody should be asked to choose between identical rows.

## Files

**`netlify/functions/_shared/deal.js`** (new) — the resolver. Classifies each deal as `program`, `addon` or `ignore`; collapses duplicates; scores programs against the trip being viewed; returns the ordered enrolment list plus the selected one.

- **`pd_program` is the classifier.** `College Credit Program` and `Basecamp` are add-ons (`DEAL_ADDON_PD_PROGRAMS`); any other value means program. Add-ons stay selectable, they're just never the default pick and they get **no application-fee or deposit buttons** — a $1,950 college credit is a single charge, so staging it against the $2,500 deposit threshold was nonsense.

  Ordering matters here: `pd_program` decides that a deal *is* a program too, not just that it isn't. Jonas's semester carries `college_credit = "Yes"` because he bought credit alongside it, and a semester named "… incl College Credit" would trip a name check — the enumeration is right in both cases.

  Coverage I measured: 51 of 52 add-on deals carry `pd_program` (the exception is Eva Norton's 2024 record). It's far patchier on program deals — about 100 of the 375 created in 2026, and the school-trip pipeline never sets it — so the deal-name pattern (`DEAL_ADDON_PATTERNS`) stays as the fallback for deals with no value. `pd_program` also gives the switcher a clean label: "College Credit Program" rather than "Jonas - College Credits ".
- **duplicates** collapse when the name and amount match *and* the records were created within 48h (`DEAL_DUPLICATE_WINDOW_HOURS`). The window is what keeps Rachel Stern's repeat enrolment on the same program at the same price from disappearing behind the newer one. The survivor is whichever record the office actually worked on; the others' ids stay attached so an old link still resolves.
- **not selectable**: test pipelines (`DEAL_PIPELINE_DENYLIST`, default `12030850`), abandoned $0 shells, `pd_program = "Dropped"`, `program_intake = "CANCELLATION"`, deals renamed "… - Cancelled", and deals closed *without* being won — a cancelled trip must not carry a live PAY NOW link. Every one of those exclusions is waived if money was taken against the deal: a student who paid and then cancelled needs to see those payments to chase the refund. Closed-**won** deals stay selectable; that's the alumni case.
- **scoring** prefers an explicit `portal_program_id` match, then an exact `pd_program` match against the Program record's name (a controlled enumeration, so nearly as reliable as an id), then partial name overlap, then tuition match, then start-date proximity, and only then recency.
- an explicit `dealId` from the browser is honoured **only** if it's in that contact's own association list.

**`netlify/functions/_shared/payments.js`** (new) — `payment_N` parsing, handling both formats in your HubSpot. The labelled 2025-era format was previously mis-parsed: Liam Ott's $12,500 final payment came out as **$937.50** (the `$12,937.50` thousands comma split the entry) and reference numbers parsed as dates in the years 465 and 8000. It now reads `Amount` in preference to `Total` (Total includes the surcharge), and rejects dates outside 2015–2035.

It also takes the **higher** of the parsed sum and `total_amount_paid` rather than always preferring the parsed sum. One unparseable row among the payments — a free-text note like "Bank transfer received – see file" — would otherwise understate what a student has paid, and understating paid means overstating a live balance. Mismatches are flagged (`discrepancy`) rather than silently reconciled.

**`get-paid-payments.js`**, **`get-document-checklist.js`** — take `dealId`, return the enrolment list, delegate selection to the resolver.

The checklist also had a live bug independent of deal selection: `pending` holds HubSpot option *values* but `options` was built from *labels*, and three of your nine options differ (value `Waiver` → label "Permissions Packet & Waiver Signed"). Students were shown a green tick against a waiver they hadn't signed while the same document also appeared as pending. It now matches on value and displays the label.

An empty `document_submissions` no longer renders "All documents submitted — thank you!", because empty means either "all done" or "nobody filled this in yet". The two now read differently.

**`get-students.js`** — the instructor roster resolves each student's deal against the portal being viewed instead of taking their newest. Add-ons appear as separate chips rather than replacing the program total. A HubSpot read failure for one student is reported on that card instead of rendering a confident $0.

**`create-checkout-session.js`** — stamps `deal_id`, `deal_name`, `deal_kind` and `deal_id_source` into the Stripe session metadata. Without this, whatever writes charges back into `payment_N` can't tell which of a student's deals the money was for. Also corrects `processing_fee_rate` from `0.03` to `0.035` to match what the portal actually charges.

**`public/index.html`** — the switcher, the `dealId` threading, and the tier-button gating.

> Worth knowing: `netlify/functions/index.html` is a **stale fork** of the portal page — 50KB smaller, missing the Bearer-token fetch wrapper and the fast-facts cards, and its `logout()` doesn't revoke the session. I started editing it by mistake before noticing `public/index.html` is the live one. I've left it untouched, but it's a trap worth deleting.

**`tests/deal.test.mjs`**, **`tests/payments.test.mjs`** (new) — 49 tests, fixtures taken from real records (Jonas, Somya, Raphael, Liam, Rachel, Kaden, Emilly, Jocelyn). `node tests/deal.test.mjs && node tests/payments.test.mjs`. The existing photo-album suite still passes.

**`scripts/deal-selection-dryrun.mjs`** (new) — read-only before/after report.

## Run this before deploying

```
HUBSPOT_API_KEY=… node scripts/deal-selection-dryrun.mjs --csv dealcheck.csv
```

It walks all 166 multi-deal contacts and prints what each sees today next to what they'll see afterwards, sorted so **any student whose AMOUNT DUE increases is at the top**. Those are the ones to review: a bigger balance than they saw last week is the one change that generates a phone call. I haven't run it — it needs the production key.

## Two things I'd still ask ops for

1. **Backfill `pd_program` on program deals.** It's the field that makes this reliable and it's already right on the add-ons; it's the ~275 program deals from 2026 without it that fall back to name-guessing. Cheaper than any new field.
2. **`portal_program_id`** (text) on Deal, holding the Program record id, set by the workflow that creates the deal. I verified neither it nor `portal_deal_role` exists yet. The code treats both as decisive when present and falls back silently when absent — no migration needed, they just improve accuracy as they get populated.
3. **`portal_deal_role`** (`program` / `addon` / `ignore`) so a mis-classified deal can be fixed in HubSpot rather than by changing a regex. Lower priority now that `pd_program` carries most of this.

Separately worth chasing in the CRM, since code can only paper over them: the duplicate-deal double-fire (Somya ×3, Emilly ×2, Keenan ×2 seconds apart), and the College Credit deals whose `payment_1` is a *copy* of the program deal's deposit line — that would double-count if payments were ever summed across deals.

## Not done

- Dropdown labels fall back to the deal name after the `-` when `pd_program` is empty, so deals named just `Rachel Stern` or `Liam Ott - New Deal` still show that. Backfilling `pd_program` fixes it.
- `college_credit` (`Yes` / `No` / `Unsure`) is read but not used. It records whether a student *wants* credit, which isn't the same as having a credit deal — worth a look if you want the program tab to mention it.
- Labelled-format payments carry no date field at all, so those history rows show "—" under the date column. Nothing to parse; the sort falls back to schedule order.
- `parsePaymentEntry` is exercised only by unit tests. The HubSpot and auth paths still need a run against the deployed functions.
