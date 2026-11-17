# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project

**Northstar Distribution — Enterprise AP/AR & Banking Payments Integration Platform.** A portfolio learning project for Senior NetSuite Developer skills. Northstar is a fictional distribution company that runs Oracle NetSuite as its ERP and connects it to vendor payments, customer payments, banking, collections and a customer self-service portal.

The source of scope is `NetSuite_AP_AR_Banking_Payments_Learning_Plan.docx`, which describes 15 phases (0–14, about 34 weeks). When a `plan.md` exists, it takes over as the working copy of that plan.

**Current state:** every phase (0–14) is implemented, tested and merged into all branches. NetSuite, the bank and the payment provider are **simulated**. `KNOWN_LIMITATIONS.md` states exactly what is real, simulated or design-only. Keep that file truthful.

## Commands

```bash
npm install
npm test                    # all tests (Vitest); a fixed clock (2026-11-20) and in-memory fakes, no network
npx vitest run <file>       # one test file; add -t "<name>" for one test
npm run ci                  # lint + prettier check + typecheck + secret scan + tests (the gate before any commit)
npm run dev                 # middleware on :3000 (PORT=... to change), portal at /portal/
npm run demo                # narrated end-to-end walkthrough
npm run loadtest            # volume test, writes docs/performance/last-run.json
npm run build && npm start  # production build (tsc + scripts/copy-assets.mjs)
TEST_DATABASE_URL=postgres://... npm test   # also runs the Store contract tests against PostgreSQL (drops schema public!)
```

## How to work with the user

The user is new to NetSuite and to programming, and learns from this code.

- **Comments explain WHY**, in beginner-friendly language, in every file. Keep this style for new code.
- **Delivery flow:** for each completed change, run `npm run ci`. Commit on `dev` and push. Then fast-forward `staging` → `production` → `main`, pushing each one, and finish back on `dev`. Never commit directly to the other branches.
- The user asked for autonomous delivery: complete the work, then report. Still explain what was built, and what needs a real NetSuite sandbox.
- Keep `DECISIONS.md`, `LEARNING_LOG.md`, `KNOWN_LIMITATIONS.md` and `docs/testing/defect-log.md` up to date.

## Hard rules

- **Never invent** NetSuite APIs, SuiteScript modules, account features or SuiteCommerce extension points. If you are unsure, say so and ask the user to check the current Oracle docs or their account.
- **Synthetic data only.** Never use real bank credentials, card numbers, CVV, live payment credentials or real customer data.
- **Mocks must be labelled.** Where NetSuite, bank or payment-provider access is unavailable, use mock adapters or simulators and label them clearly. Never present a local portal prototype as a deployed SCMA extension.
- **Never claim** that something is production-ready or PCI DSS compliant.
- **Keep secrets out of Git**, logs and ordinary DB tables. Commit only `.env.example`. Keep account-specific object IDs, deployment IDs and credentials out of shared source.
- **Accounting treatment is not yours to decide.** Document the assumptions and flag them for review by a qualified accounting stakeholder.

## Architecture principles

- **NetSuite is the system of record** for vendors, customers, bills, invoices, payments, journals and GL impact. The middleware database holds integration metadata only and must never become a second ledger.
- The middleware never silently creates accounting entries. Every entry needs a defined business mapping and an approval.
- Every externally started operation carries a `correlationId`, an `externalId` and an idempotency key.
- Webhooks are authenticated (signature verified), stored, acknowledged quickly and processed asynchronously. They are also protected against replay and duplicates.
- Retries are bounded, use exponential backoff with jitter, and separate transient failures (429, 5xx, timeouts) from permanent business errors (4xx). Failed messages go to a dead-letter queue, and replay is a controlled, separate action.
- Payment state transitions are explicit and audited. The states are: Draft → Validated → Approved → Submitted → Accepted → Settled → Reconciled, plus Failed, Returned and Reversed.
- Payment batches use maker-checker approval, carry immutable batch references and detect duplicate bills.

**Component split:**

- **SuiteScript 2.x:** NetSuite-side validation and automation, bounded by governance limits. Map/Reduce scripts must be safe to restart.
- **SuiteFlow:** declarative approval and status workflows.
- **Node.js middleware:** orchestration, provider adapters, mapping, retries, webhooks, file and SFTP processing, monitoring.

## Coding conventions

- **Middleware:** TypeScript Node.js with layers for `api/`, `application/`, `domain/`, `infrastructure/`, `adapters/` (`netsuite/`, `payment-provider/`, `bank/`) and `shared/`. Provider-specific payloads stay inside the adapters, and the rest of the code uses stable internal domain models.
- **Money:** use decimal-safe types or strings. Never use binary floating point for money. Always state the currency code explicitly (ISO 4217).
- **Timestamps:** ISO 8601.
- **APIs:** versioned under `/api/v1/...`, documented with OpenAPI, and every inbound payload is schema-validated.
- **Logging:** structured logs with correlation IDs. Never log secrets, card data or sensitive payment data.
- **Audit events** record the actor, action, entity reference, correlation ID, timestamp, source and outcome.
- **Persistence:** PostgreSQL holds integration jobs, idempotency keys, webhook receipts, audit events and provider references.
- Each layer should cover config validation, centralized error handling, and health and readiness endpoints.

## Repository layout and how the code fits together

```
middleware/src/
  domain/          pure rules (money, payment-state, eligibility, payment-batch, ar, reconciliation). No I/O.
  application/     use cases + ports/ (store, netsuite, payment-provider interfaces)
  adapters/        netsuite/ (mock, rest, soap ref, suiteql, oauth1), bank/ (nacha, payment-files, vault,
                   statement-parsers), payment-provider/ (simulator, webhook signatures), source/ (mapping)
  infrastructure/  memory/ + db/ (Store impls, migrations), files/ (LocalFolderSftp), secrets/
  api/             http.ts (context, auth, roles, validation, idempotency, errors), security.ts, routes/
  container.ts     composition root: the ONLY place that wires concrete implementations
middleware/tests/  unit/, contract/, api/, reliability/, e2e/, plus helpers.ts (makeTestContext)
netsuite/          SDF project (src/FileCabinet/SuiteScripts/northstar/*, src/Objects/*.xml), suiteql/, tests/ (AMD harness)
simulators/bank/   bank simulator    portal/   local-prototype + scma-extension design
docs/              see docs/architecture/overview.md for the full map; LEARNING_PATH.md is the reading order
```

**Patterns to follow when changing code:**

- **Follow-up work goes through the outbox.** Inside the business transaction, call `dispatcher.dispatch(topic, payload, { tx })`. After commit, call `await dispatcher.flush()`.
- **Every topic needs a handler.** Register it with `jobs.register(topic, handler)` in the service constructor. Handlers must be idempotent: NetSuite creates are keyed by `externalId`.
- **New services are wired only in `container.ts`.** New routes are mounted in `app.ts`.
- **New collections need two updates.** Add the collection and its filterable fields to `COLLECTIONS` in `application/ports/store.ts`, **and** add a table and indexes in a new migration file. A test checks that they agree.
- **Field IDs live in one place on each side.** SuiteScript field IDs come only from `lib/nsd_constants.js`, and each has an SDF XML object (enforced by tests). The collection-stage rule exists in both `domain/ar.ts` and `nsd_rules.js`, and a parity test enforces that they match.
- **Tests use the shared setup.** Use `makeTestContext()` (fixed clock, mock NetSuite, temp SFTP folder, no retry sleep). Pass config overrides as the second argument.

**Gotchas:**

- Prettier sometimes needs two `--write` passes before `format:check` passes.
- `package-lock.json` must be regenerated on Linux (for example in a `node:22-alpine` container) when dependencies change. A Windows-generated lockfile drops Linux optional dependencies, and `npm ci` then fails in CI and Docker.
- On this machine, ports 3000 and 5432 may already be used by other projects. Use `PORT`, `MW_PORT` and `DB_PORT`.

## Core entities

`IntegrationJob`, `IdempotencyRecord`, `PaymentBatch`, `PaymentInstruction`, `WebhookReceipt`, `Settlement` (gross, fees and net amounts), `ReconciliationMatch` (match rule, confidence, reviewer) and `AuditEvent`.

## Phase roadmap (all completed)

| Phase | Focus                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Environment, access checklist, repo setup (README, .gitignore, .env.example, lint, format, test), system-of-record ADR |
| 1     | P2P and O2C process maps, accounting mapping matrix, payment state diagram, glossary                                   |
| 2     | NetSuite configuration, custom records and fields, saved searches, data dictionary                                     |
| 3     | SuiteScript: User Event, Client, Scheduled, Map/Reduce, Suitelet, RESTlet                                              |
| 4     | SuiteFlow (AP approval, AR collections), saved searches, SuiteQL library                                               |
| 5     | Middleware foundation, OpenAPI, auth, SuiteTalk REST and SOAP adapters, PostgreSQL                                     |
| 6     | NetSuite ↔ middleware sync, external ID mapping, dead-letter queue and replay                                          |
| 7     | AP payment proposals and batches, simulated NACHA, wire and virtual-card files, SFTP, status callbacks                 |
| 8     | AR payments, hosted-checkout simulation, webhooks, refunds and voids, collections                                      |
| 9     | SuiteCommerce MyAccount portal, or a clearly labelled local prototype                                                  |
| 10    | Bank statement import (CSV and XML), reconciliation engine, exception queue                                            |
| 11    | Idempotency, outbox and inbox, DLQ, secrets, threat model, load testing                                                |
| 12    | Unit, contract, end-to-end and UAT tests, accounting reconciliation                                                    |
| 13    | SDF, CI/CD quality gates, AWS or Azure deployment, rollback runbook                                                    |
| 14    | Runbooks, SLOs, documentation, portfolio demo                                                                          |

## Definition of done (every phase)

A phase is done when all of these hold:

- The flow can be explained in plain language.
- The work is committed with meaningful history.
- The tests pass.
- Retries, duplicates and partial failures are tested.
- Logs carry correlation IDs and no secrets.
- Mappings and accounting assumptions are documented.
- A demo or evidence artifact exists.
- Deploy and rollback steps are documented.
- The choice of NetSuite pattern is justified.
