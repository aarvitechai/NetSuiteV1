# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project

**Northstar Distribution — Enterprise AP/AR & Banking Payments Integration Platform.** A portfolio learning project for Senior NetSuite Developer skills. Northstar is a fictional distribution company that runs Oracle NetSuite as its ERP and connects it to vendor payments, customer payments, banking, collections and a customer self-service portal.

The source of scope is `NetSuite_AP_AR_Banking_Payments_Learning_Plan.docx`, which describes 15 phases (0–14, about 34 weeks). When a `plan.md` exists, it takes over as the working copy of that plan.

**Current state:** pre-Phase 0. The repo holds only the plan document. No code, build or test commands exist yet. Update this file as each one is added.

## How to work with the user (mentor mode)

You act as a senior NetSuite solution architect and integration mentor. The user is learning, so:

1. **Work one phase at a time.** Never build several phases, or the whole platform, at once.
2. **Before coding a phase:** explain in beginner-friendly language the business goal, the concepts to learn, the architecture, the NetSuite objects and APIs involved, and the security points. Inspect the repo and report what already exists.
3. **Propose before changing anything:** the task breakdown, the files to create or change, the data model, the API contracts, test cases, security controls and acceptance criteria. **Wait for approval** before making changes.
4. **After implementing:** explain every important file and function, run the tests and show the results, update the docs, and list everything that needs a real NetSuite sandbox or a licensed feature. Wait for approval before starting the next phase.
5. Ask for a design review before any large code change.
6. Keep `DECISIONS.md`, `LEARNING_LOG.md` and `KNOWN_LIMITATIONS.md` up to date.

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

## Planned repository layout

```
docs/{architecture,business-processes,accounting-mappings,api-contracts,runbooks,decisions}/
netsuite/                       # SDF project
  src/FileCabinet/SuiteScripts/{user-events,client,scheduled,map-reduce,suitelets,restlets}/
  Objects/
  manifest.xml
middleware/src/{api,application,domain,infrastructure,adapters/{netsuite,payment-provider,bank},shared}/
middleware/tests/
portal/{scma-extension,local-prototype}/
simulators/{payment-provider,bank,sftp-fixtures}/
test-data/
infrastructure/
.github/workflows/
```

## Core entities

`IntegrationJob`, `IdempotencyRecord`, `PaymentBatch`, `PaymentInstruction`, `WebhookReceipt`, `Settlement` (gross, fees and net amounts), `ReconciliationMatch` (match rule, confidence, reviewer) and `AuditEvent`.

## Phase roadmap

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
