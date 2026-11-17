# Learning log

One entry per phase: what was built, the key concepts, and answers to the plan's review questions.

## Phase 0 — Environment, access and project setup

**Built:**

- Repository scaffold: TypeScript, ESLint, Prettier and Vitest.
- `.env.example`.
- Validated configuration in `middleware/src/shared/config.ts`.
- Access checklist.
- ADR-0001.
- Branch policy (`dev → staging → production → main`).

**Key concepts**

- **Production, sandbox and local simulation.**
  - _Production_ is the live company account, holding real money and real data.
  - A _sandbox_ is a copy of the account for testing. It is still NetSuite, but transactions
    there have no real-world effect.
  - _Local simulation_ (this repo's mocks) involves no NetSuite at all. It runs fast and for
    free, but it only _imitates_ NetSuite's behaviour.
- **Why validate config at start-up?** A bad configuration should crash the app immediately, with a
  clear message. It is far worse to discover it halfway through a payment batch.

**Review questions**

1. _Why does NetSuite remain the accounting system of record?_
   Finance closes the books in NetSuite, auditors look at NetSuite, and the GL lives there. A second
   copy of balances in the middleware would drift and create reconciliation work.
2. _What is the difference between production, sandbox and local simulation?_
   See the key concepts above.
3. _Which features require licensing or administrator enablement?_
   SuiteCommerce MyAccount, payment SuiteApps and bank feeds need licences. REST and SOAP web
   services, Token-Based Authentication, SuiteScript, SuiteFlow and SDF need an administrator to
   enable them under _Setup → Company → Enable Features_. See `docs/access-checklist.md`.

## Phase 1 — Business process and accounting foundations

**What I built**

- BRD with P2P and O2C diagrams
- payment state machine (`domain/payment-state.ts`) with its diagram
- decimal-safe money type (`domain/money.ts`)
- accounting event matrix
- glossary
- exception catalogue

**Review questions**

1. _When should a vendor bill affect the GL?_ When the bill is approved and posted (Dr expense,
   Cr AP). The vendor _payment_ affects the GL only at settlement.
2. _How is a payment different from a settlement?_ A payment is the instruction ("please pay").
   Settlement is the money actually moving. An accepted payment can still fail.
3. _What happens when a payment is returned after it was marked as submitted?_ If it never settled,
   it moves Submitted/Accepted → Failed and the bill is released. If it had settled, it moves
   Settled → Returned → Reversed: the Vendor Payment is voided, the bill reopens, and AP contacts the vendor.

## Phase 2 — NetSuite data model and configuration

**What I built**

- SDF project (`netsuite/`) with 11 body fields, 3 entity fields and 3 custom records
- `nsd_constants.js`, the single source of field IDs
- saved search definitions in code (`nsd_searches.js`)
- AMD test harness, plus a test that keeps the field IDs and SDF objects in sync
- data dictionary
- synthetic seed data (`test-data/netsuite/`)

**Review questions**

1. *Standard record or custom record?* Use a standard record when NetSuite already models the business
   object and its GL impact (bill, payment). Use a custom record for data NetSuite has no concept of,
   such as a payment batch or a reconciliation match. Never imitate a standard transaction with a
   custom record.
2. *Why are external IDs useful?* They let you upsert without looking up the internal ID, they make
   retries duplicate-safe, and they let you trace a record back to the source system.
3. *What belongs in NetSuite and what in the middleware?* See the table in `docs/netsuite/data-dictionary.md`.

## Phase 3 — SuiteScript 2.x fundamentals and automation

**What I built**

- one script of each type (UE, CS, SS, MR, SL, RL)
- pure rules library
- integration-log library
- SDF script objects and deployments
- fake `N/*` modules, with 35 behaviour tests

**Review questions** (answered in detail in `docs/netsuite/suitescript-guide.md`)

1. *Which logic belongs where?* Integrity → User Event. Experience → Client. Periodic → Scheduled.
   Volume → Map/Reduce.
2. *What happens when a script exceeds governance?* `SSS_USAGE_LIMIT_EXCEEDED`: the script stops
   and earlier saves are kept. Design for it by rescheduling or by using Map/Reduce.
3. *Why must Map/Reduce be restart-safe?* An invocation can be re-run, so the work must be idempotent.

## Phase 4 — SuiteFlow, saved searches and SuiteQL

**What I built**

- AP approval and AR collections workflow specs (`docs/netsuite/workflows.md`)
- approval thresholds in code (`approvalRoute`)
- 5 SuiteQL queries
- injection-safe `bindSuiteQL`
- convention tests for the SQL files

**Review questions**

1. *When is SuiteFlow preferable to SuiteScript?* For state- and approval-driven processes that use
   standard actions and that business users should be able to see. See the table in the workflow doc.
2. *What query patterns become expensive?* Unfiltered transaction scans, line-level rows, formulas
   over many rows, and searches inside loops.
3. *How do you avoid an over-permissive RESTlet?* Allow-lists, input validation, a restricted
   audience, and no generic query passthrough.

## Phase 5 — Node.js middleware foundation

**What I built**

- Express 5 + TypeScript service
- structured logging with redaction
- correlation IDs (AsyncLocalStorage)
- bearer auth with roles
- Zod validation
- consistent error format
- health and readiness endpoints
- idempotency service
- audit service
- Store port, with a memory and a PostgreSQL implementation (contract-tested against both)
- NetSuite port, with three implementations:
  - mock adapter, with fault injection
  - REST adapter (TBA signing, SuiteQL paging)
  - SOAP reference envelope
- OpenAPI spec
- developer setup guide

**Review questions**

1. *Why use an adapter layer?* It isolates NetSuite specifics, enables testing with mocks, and limits
   the impact of change. See `docs/architecture/netsuite-integration.md`.
2. *How do OAuth tokens expire and refresh?* TBA tokens do not expire; they are revoked. OAuth 2.0
   access tokens expire after about 60 minutes. The client caches the token, refreshes it before
   expiry, and on a 401 refreshes once and retries once.
3. *400 versus 429 versus 5xx?* 400 is a permanent business error: don't retry, send to a human.
   429 and 5xx are transient: retry with backoff and honour Retry-After.

## Phase 6 — NetSuite ↔ middleware integration

**What I built**

- bounded retries with exponential backoff, full jitter and Retry-After support
- integration jobs
- dead-letter queue with replay and discard
- upstream → domain mapping with Zod, plus contract tests
- vendor and customer sync with bounded concurrency and per-record isolation
- a failure → DLQ → replay demo, traced under one correlation ID
- field mapping spec

**Review questions**

1. *How do you prevent duplicate records during a retry?* Upsert or create keyed on `externalId`, and
   look the record up before creating it. The idempotency key at the API level replays the stored
   response.
2. *What should happen when NetSuite is temporarily unavailable?* First, bounded retries with
   backoff and jitter. Then the dead-letter queue, which keeps the original payload and correlation ID.
   After recovery, operations replays the work. Handlers are idempotent, so the replay is safe. Healthy
   records in the same batch are not blocked.
3. *Which integration approach is best for each operation?* See the table in
   `docs/architecture/netsuite-integration.md`. In short: REST upsert (`eid:`) for master data, SuiteQL
   for reads, REST POST with `externalId` for transactions, and a RESTlet only where a narrow permission
   scope is needed.
