# SuiteScript guide: scripts, deployment, governance and review checklist (Phase 3)

## Scripts in this repo

All scripts are in `netsuite/src/FileCabinet/SuiteScripts/northstar/`.

| Script | Type | Trigger | Why this type |
|---|---|---|---|
| `user-events/nsd_ue_vendor_bill.js` | User Event | Every save of a Vendor Bill (UI, CSV, web services) | Server-side, and it cannot be bypassed, so it is the integrity boundary |
| `client/nsd_cs_vendor_bill.js` | Client Script | Vendor Bill form in the browser | Instant user feedback. Not a security boundary. |
| `scheduled/nsd_ss_stale_payments.js` | Scheduled | Nightly | Periodic maintenance with no user involved |
| `map-reduce/nsd_mr_collections.js` | Map/Reduce | Daily | High volume, parallel, and restart-safe |
| `suitelets/nsd_sl_batch_review.js` | Suitelet | A user opens the page | A custom UI page inside NetSuite |
| `restlets/nsd_rl_integration_status.js` | RESTlet | Middleware HTTP call | One narrow, validated integration endpoint |
| `lib/*.js` | Library modules | Imported by the scripts | Shared, pure and tested logic |

## Which logic goes where

- **User Event:** data integrity rules that must hold no matter how the record is saved.
- **Client Script:** user experience only. Duplicate the rule (by calling the same library) but
  never rely on it.
- **Scheduled Script:** small or medium periodic jobs. Must reschedule itself before running out of
  governance units.
- **Map/Reduce:** anything that touches many records. NetSuite handles yielding, parallelism and
  per-stage governance for you.
- **Suitelet:** custom pages and small internal tools.
- **RESTlet:** an integration endpoint that needs custom logic or a narrower permission scope than
  SuiteTalk REST.

## Governance (usage units)

Every NetSuite API call costs units, and each script type has a budget. The numbers below are typical
values. **Check the current Oracle documentation for exact values.**

| Script type | Typical budget per execution |
|---|---|
| User Event / Client | 1,000 |
| Suitelet / RESTlet | 5,000 |
| Scheduled | 10,000 |
| Map/Reduce | Separate limits per `map`/`reduce` invocation, plus automatic yielding |

**What happens when a script exceeds governance?** NetSuite throws `SSS_USAGE_LIMIT_EXCEEDED` and stops
the script. Changes already saved stay saved, so a half-finished loop leaves data half-processed. That
is why:

- the Scheduled Script checks `getRemainingUsage()` and **reschedules itself** with `N/task`;
- the Map/Reduce processes **one record per `reduce`**, so a failure only affects that record, and
  `summarize` reports it.

**Why must a Map/Reduce be restart-safe?** NetSuite can restart a `map` or `reduce` invocation, for
example after a server failure, and `context.isRestarted` is then true. The same record may be
processed twice, so the work must be idempotent: computed deterministically, skipped if already done,
and written as "set value" rather than "add/increment".

## Avoiding duplicate transactions on partial failure

- Records created by integrations always carry an `externalid`. NetSuite rejects a second record with
  the same external ID.
- The User Event rejects a duplicate vendor invoice number for the same vendor.
- The Map/Reduce writes are idempotent ("set stage = X").

## Deploying (with access to a sandbox)

```bash
cd netsuite
npx @oracle/suitecloud-cli account:setup     # link this machine to a sandbox (interactive)
npx @oracle/suitecloud-cli project:validate  # validates manifest, objects and script references
npx @oracle/suitecloud-cli project:deploy    # deploys files and objects
```

After deploying:

1. Open each script deployment, set the **Audience**, and keep the status at **Testing**.
   - The RESTlet's audience is only the *NSD Integration* role.
   - The Suitelet's audience is the AP and Ops roles.
2. Test every row of the test-case table below in the sandbox. Then set the status to **Released**.

## Test cases

| # | Script | Case | Expected | Automated? |
|---|---|---|---|---|
| T1 | UE | Create a bill with total 0 | Error `NSD_VALIDATION_FAILED` | ✅ harness |
| T2 | UE | Second bill with the same vendor and invoice no. | Error `NSD_DUPLICATE_BILL` | ✅ harness |
| T3 | UE | Edit the amount of an in-progress bill | Error `NSD_BILL_LOCKED` | ✅ harness |
| T4 | UE | Inline-edit the memo of an in-progress bill | Allowed | ✅ harness (verify `getFields()` on XEDIT in the sandbox) |
| T5 | CS | Save with an empty Reference No. | Alert, and the save is cancelled | ✅ harness |
| T6 | SS | Usage runs low mid-loop | Script reschedules itself | ✅ harness |
| T7 | MR | Invoice 35 days overdue in REMINDER_1 | Moves to REMINDER_2 | ✅ harness |
| T8 | MR | Restarted map | Same output as the first run | ✅ harness |
| T9 | SL | POST request | "Method not allowed" | ✅ harness |
| T10 | RL | PUT with `type=employee` | `NSD_TYPE_NOT_ALLOWED` | ✅ harness |
| T11 | All | Real governance consumption | Within budget | ❌ sandbox only |

## Code review checklist

- [ ] Correct `@NApiVersion 2.1` and `@NScriptType` annotations.
- [ ] Field IDs come only from `nsd_constants.js`.
- [ ] Business rules are in `lib/` and unit tested.
- [ ] Every loop over search results checks governance, or runs in a Map/Reduce.
- [ ] Writes are idempotent (safe to run twice).
- [ ] Errors use `N/error` with an `NSD_*` code. No silent `catch {}`.
- [ ] No secrets, card data or full payloads in `log.*` calls. Use `rules.redact()`.
- [ ] RESTlet input is validated against allow-lists, and the deployment audience is restricted.
- [ ] Client-side validation is duplicated on the server.
