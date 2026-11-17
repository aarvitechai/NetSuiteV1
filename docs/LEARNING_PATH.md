# Learning path: how to read this codebase

This repository is meant to be **read**. Every file has comments explaining *why* it exists. Follow
the steps in order. Each step builds on the one before. Run the related tests as you go:
`npx vitest run <test file>`. Change something, and watch a test fail. That is the fastest way to
learn.

## Step 1: the business (no code yet)

1. `plan.md`: what we are building and why.
2. `docs/business-processes/brd.md`: Procure-to-Pay and Order-to-Cash in plain language.
3. `docs/business-processes/glossary.md`: AP, AR, settlement, NACHA, idempotency…
4. `docs/accounting-mappings/accounting-event-matrix.md`: which event creates which journal entry.
5. `docs/decisions/ADR-0001-system-of-record.md`: why NetSuite owns the money.

## Step 2: pure business rules (`middleware/src/domain`)

These files contain no databases and no HTTP, only logic. Start here.

| Read | Then run | You will learn |
|---|---|---|
| `domain/money.ts` | `tests/unit/money.test.ts` | Why floats are dangerous for money, and how decimal.js fixes it |
| `domain/payment-state.ts` | `tests/unit/payment-state.test.ts` | State machines: allowed transitions only |
| `domain/eligibility.ts` | `tests/unit/eligibility.test.ts` | Business rules as pure functions, and duplicate detection |
| `domain/payment-batch.ts` | — | Maker-checker, and the content hash for immutability |
| `domain/ar.ts` | — | Payment intents, aging buckets, collection stages |
| `domain/reconciliation.ts` | `tests/unit/reconciliation-matching.test.ts` | Matching rules and confidence scores |

## Step 3: shared building blocks (`middleware/src/shared`)

`config.ts` (validate config at start-up), then `errors.ts` (transient versus permanent), then
`context.ts` (correlation IDs through AsyncLocalStorage), then `logger.ts` (structured logs and
redaction), then `util.ts` (clock injection and stable hashing).

## Step 4: ports and storage

1. `application/ports/store.ts`: what a "port" (interface) is.
2. `infrastructure/memory/memory-store.ts`: transactions with an undo log.
3. `infrastructure/db/pg-store.ts` and `migrations/001_init.sql`: the same interface, backed by
   PostgreSQL.
4. Test: `tests/unit/store.test.ts`. One contract, two implementations.

## Step 5: NetSuite integration

1. `application/ports/netsuite.ts`: everything we need from NetSuite.
2. `adapters/netsuite/mock-netsuite.ts`: the simulator (externalId uniqueness, fault injection).
3. `adapters/netsuite/oauth1.ts`: how TBA request signing works.
4. `adapters/netsuite/rest-netsuite.ts`: SuiteTalk REST, the `eid:` upsert, SuiteQL paging,
   idempotent creates.
5. `adapters/netsuite/errors.ts`: when to retry (429, 5xx) and when not to (400).
6. Tests: `tests/unit/netsuite-adapters.test.ts`.

## Step 6: NetSuite-side code (`netsuite/`)

1. `src/FileCabinet/SuiteScripts/northstar/lib/nsd_rules.js`: pure rules shared by all scripts.
2. One script per type: User Event, then Client, then Scheduled, then Map/Reduce, then Suitelet, then
   RESTlet. Read the header comments: *why this script type?*
3. `tests/harness/amd-loader.ts`: how SuiteScript is tested without NetSuite.
4. `docs/netsuite/suitescript-guide.md`: governance, and the code-review checklist.

## Step 7: the HTTP layer

`app.ts` (the order of the middleware), then `api/http.ts` (auth, roles, validation, idempotency,
errors), then `api/routes/*.ts`. Test: `tests/api/foundation.test.ts`.

## Step 8: reliability, the core of senior-level integration work

| Read | Concept |
|---|---|
| `application/idempotency.ts` | Making requests safe to repeat |
| `application/retry.ts` | Exponential backoff and jitter |
| `application/jobs.ts` | Integration jobs, the DLQ, replay |
| `application/dispatcher.ts` | **Transactional outbox** (the dual-write problem) |
| `application/webhooks.ts` | Inbox: verify, persist, acknowledge, process |
| `docs/architecture/reliability.md` | How all of these fit together |

## Step 9: business flows end to end

1. **AP:** `application/ap-payments.ts`, then `adapters/bank/nacha.ts`, then
   `adapters/bank/payment-files.ts`, then `application/bank-inbound.ts`, then
   `simulators/bank/bank-simulator.ts`. Test: `tests/api/ap-payments.test.ts`.
2. **AR:** `application/ar-payments.ts`, then `adapters/payment-provider/*`, then
   `application/collections.ts`. Test: `tests/api/ar-payments.test.ts`.
3. **Portal:** `api/routes/portal.ts` and `portal/local-prototype/app.js`. Test:
   `tests/api/portal.test.ts`.
4. **Reconciliation:** `adapters/bank/statement-parsers.ts`, then `application/reconciliation.ts`,
   then `application/control-totals.ts`. Tests: `tests/api/reconciliation.test.ts` and
   `tests/e2e/period-close.test.ts`.

## Step 10: operations

`docs/architecture/security.md`, then `docs/performance/report.md` (a real bug found by load
testing), then `Dockerfile`, then `.github/workflows/*.yml`, then `docs/runbooks/`, then
`docs/testing/defect-log.md` (every real bug found while building this, and how it was caught).

## Exercises

1. Add a new eligibility rule: "skip bills under 10.00". Write the test first.
2. Add a new collection stage `FINAL_NOTICE` at 90 days, in **both** `domain/ar.ts` and
   `nsd_rules.js`. Watch the parity test protect you.
3. Make NetSuite fail 5 times instead of 4 in `integration.test.ts`. What happens, and why?
4. Remove the `remember()` call from one repository method in `memory-store.ts`. Which test catches
   it?
5. Run `npm run demo` and read the output next to `scripts/demo.ts`.
