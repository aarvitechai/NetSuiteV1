# Defect log

These are real defects found while building this project. Each one is now guarded by a test.

Severity:

- **1** means money or data could be wrong.
- **2** means security or reliability.
- **3** means functional.
- **4** means tooling.

| ID | Phase | Sev | Found by | Defect | Fix | Guarding test |
|---|---|---|---|---|---|---|
| D-001 | 3 | 2 | Unit test | `redact()` left the token in `Authorization: Bearer <token>`. Only the word "Bearer" was removed. | The regex now consumes the scheme word as well | `netsuite/tests/rules.test.ts` "redacts card numbers and secrets" |
| D-002 | 5 | 3 | Contract test | The REST adapter resolved vendor and bill IDs *before* checking whether the payment already existed. That wasted API calls on every retry. | Request bodies are built lazily inside `createOnce` | `netsuite-adapters.test.ts` "createVendorPayment returns the existing record…" |
| D-003 | 6 | 4 | API test | Mock fault injection could not target one record, so concurrent records shared the injected faults | `injectFault(..., key)` | `integration.test.ts` partial-failure test |
| D-004 | 6 | 2 | API test | The audit event for a DLQ replay was written under the *new* request's correlation ID, which split the trace in two | The replay runs entirely under the original correlation ID | `integration.test.ts` "…replays it after the outage" |
| D-005 | 2 | 4 | CI | A lint error in `suitecloud.config.js` was shipped, because the ship step did not stop on CI failure | The ship script is now gated on `npm run ci` | (process) |
| D-006 | 7 | 4 | CI | Prettier is not idempotent in one pass on some long lines, so CI failed after formatting | Format runs twice before CI | (process) |
| D-007 | 10 | 3 | API test | A file name with path traversal returned 500 instead of 400 | `assertSafeName` throws `ValidationError` | `reconciliation.test.ts` quarantine test |
| D-008 | 11 | 3 | Security test | An oversized JSON body returned 500 instead of 413 | The error handler maps body-parser errors | `security.test.ts` "rejects oversized JSON bodies" |
| D-009 | 11 | 3 | Security test | Prometheus metrics without labels were rendered as `name{}`, which is invalid | Key format fixed | `security.test.ts` metrics test |
| D-010 | 11 | 2 | Security test | A **top-level** `consumerSecret` field was not redacted from logs. Only nested fields were. | Redact paths now cover the top level and one level deep for every sensitive name | `security.test.ts` "never writes secrets…" |
| D-011 | 11 | 2 | Load test | `MemoryStore.transaction` deep-copied the whole store, which capped AR payments at 10/s | Undo-log transactions: **64× faster** | `store.test.ts` rollback contract plus `docs/performance/report.md` |
| D-012 | 11 | 3 | Load test (analysis) | The REST adapter flags bills one PATCH at a time, giving N requests per batch | **Open.** Recommendation recorded in the performance report (bulk RESTlet or Map/Reduce). | — |

## Open defects

| ID | Sev | Owner | Target |
|---|---|---|---|
| D-012 | 3 | Integration team | Before the first production batch with more than 100 bills |
