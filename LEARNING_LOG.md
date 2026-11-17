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

## Phase 7 — Accounts Payable and vendor payments

**What I built**

- eligibility rules (11 reasons)
- payment proposal
- batches with maker-checker approval and an immutable content hash
- one instruction per vendor
- NACHA generator and validator, plus wire CSV and virtual-card JSONL files
- bank vault tokens
- local SFTP with archive and quarantine
- bank simulator (ACK, settle, returns)
- inbound file processing with duplicate detection
- NetSuite Vendor Payment created only at settlement
- returns voided and reversed
- runbook and sample files

**Review questions** (see `docs/architecture/ap-payments.md`)

1. *Acceptance versus settlement?* Acceptance means the bank agreed to process the instruction.
   Settlement means the money actually moved.
2. *How do you avoid paying a bill twice?* Seven layered defences: flags, open-batch check, duplicate
   invoice check, approval re-check, content hash, idempotency keys and externalIds.
3. *Which statuses post to NetSuite?* Only `Settled` (create the payment) and `Reversed` (void it).

## Phase 8 — Accounts Receivable, customer payments and collections

**What I built**

- Payment intents with a server-side ownership check, and a strict schema that rejects card fields.
- Simulated hosted-checkout provider supporting automatic and manual capture, void, refund,
  chargeback and daily settlement with fees.
- HMAC webhook signatures with a timestamp tolerance.
- Webhook inbox (deduplicated by event ID) that acknowledges immediately and processes asynchronously.
- NetSuite postings: Customer Payment, Customer Refund, return reversal, and a Deposit of the net
  amount with fees on a separate line.
- Settlement arithmetic checks.
- Aging report.
- Idempotent collections runs with a communication audit trail.
- Disputes.
- Parity test showing the middleware and NetSuite compute the same collection stage.

**Review questions**

1. *Why is a hosted payment page or tokenization safer?*
   - Card data never enters our systems, so we cannot leak it or log it.
   - PCI DSS scope shrinks dramatically.
   - The provider, which is certified, carries the card-handling risk.
2. *How do you handle a webhook delivered more than once?*
   - The inbox table is keyed by event ID, so a duplicate is answered 200 and nothing happens.
   - Every handler also checks business state before acting. See
     `docs/api-contracts/webhooks-and-customer-payments.md`.
3. *How should fees and net settlement be represented?*
   - The Customer Payment is booked at gross, which clears AR in full.
   - The Deposit is booked at net, with the fee as a separate expense line.
   - The Deposit then equals the bank statement line.

## Phase 9 — SuiteCommerce MyAccount customer portal

**What I built**

- portal API (`/portal/me`, `/portal/statement`) scoped by the token subject
- plain-language pending and settled statuses
- an accessible, clearly labelled local prototype (HTML, CSS and JS, with CSP and textContent rendering)
- simulated hosted checkout, mounted only outside production
- UX spec with access-control matrix
- SCMA extension design plan (not implemented, no licence)

**Review questions**

1. *Where should customer authorization be enforced?* On the server, from the authenticated identity.
   Never from request parameters, and never by hiding things in the UI.
2. *Which customisations does the deployed SCMA version support?* That must be verified against the
   account's SC version and the documented extension points. See `portal/scma-extension/README.md`.
3. *Pending versus settled?* "Payment received – processing" while the payment is succeeded but not
   settled. "Completed" once the settlement Deposit is posted.

## Phase 10 — Bank integration, reconciliation and settlement

**What I built**

- CSV and camt.053 parsers. They reject DOCTYPE/ENTITY, keep amounts as strings, and check
  balance integrity.
- Duplicate-line detection keyed by bank reference.
- Matching engine with these rules: EXACT_REF, GROUP_REF (one-to-many), SPLIT_REF (many-to-one),
  AMOUNT_DATE, and exceptions for mismatch, ambiguous and unmatched lines. Each match gets a
  confidence score.
- Auto-approval threshold.
- Finance approve and reject.
- Manual matching that must balance.
- Rematch after late postings.
- Finalization: instructions move to Reconciled and a NetSuite custom record is created.
- Reconciliation report.
- Quarantine replay.
- Bank simulator statements (CSV and camt.053, with optional ACH aggregation).
- Sample statements.

**Review questions** (see `docs/architecture/reconciliation.md`)

1. *Settlement versus reconciliation?* Settlement is a claim that money moved. Reconciliation is
   independent proof of it from the bank statement.
2. *One-to-many and many-to-one?* Handled by the GROUP_REF and SPLIT_REF rules, or by a manual match.
   In every case the totals must be exactly equal.
3. *Which unmatched items need human approval?* Everything below 0.95 confidence, and every exception.

## Phase 11 — Reliability, security, audit and performance

**What I built**

- Transactional outbox, in inline or worker mode, with crash recovery. Inbox plus outbox for webhooks.
- Per-IP rate limiting and security headers.
- Prometheus `/metrics` and an ops dashboard.
- Secret provider with a caching TTL for rotation. The webhook secret can be rotated (previous secret
  still accepted).
- Stronger log redaction, plus a test proving it.
- Failure-injection tests.
- STRIDE threat model, access-control matrix and PCI scope notes.
- Load test and performance report. The load test found an O(N) bottleneck, and fixing it made
  payments 64× faster.

**Review questions**

1. *What is the difference between retrying and replaying?* Retry is automatic and immediate, for
   transient errors. Replay is deliberate and later, after the root cause is fixed, and reuses the
   original payload and correlation ID.
2. *How do idempotency keys and unique external references work together?* The key protects the
   client-to-middleware boundary. The externalId protects the middleware-to-NetSuite boundary, which
   is the final safety net for the general ledger.
3. *What data must never appear in logs?* Card numbers, CVV, full bank account numbers, passwords,
   API tokens, OAuth secrets, webhook signatures and secrets, and full request bodies.
