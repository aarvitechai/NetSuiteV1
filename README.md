# Northstar Distribution — AP/AR & Banking Payments Integration Platform

This is a **portfolio learning project**: an end-to-end Oracle NetSuite integration platform for the
fictional Northstar Distribution. It covers:

- **Accounts Payable:** bill eligibility, maker-checker payment batches, NACHA, wire and virtual-card
  files over SFTP, bank acknowledgements, settlements and ACH returns.
- **Accounts Receivable:** hosted online payments, signed webhooks, refunds, chargebacks, provider
  settlements with fees, collections, and a customer portal.
- **Banking:** CSV and ISO 20022 camt.053 statements, and a reconciliation engine with an exception
  queue.
- **NetSuite:** SuiteScript 2.x (all six script types), custom records and fields (SDF), saved
  searches, SuiteQL, SuiteFlow specs, and a SuiteTalk REST adapter with TBA.
- **Engineering:** idempotency, a transactional outbox, retries, a DLQ with replay, audit, metrics,
  security hardening, a load test, CI/CD and a Docker deployment.

> **All data is synthetic.** NetSuite, the bank and the payment provider are **simulated**. See
> [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for exactly what is real, simulated or design-only.
> This project makes no PCI DSS compliance claim.

[![CI](https://github.com/aarvitechai/NetSuiteV1/actions/workflows/ci.yml/badge.svg)](https://github.com/aarvitechai/NetSuiteV1/actions/workflows/ci.yml)

## Quick start

```bash
npm install
cp .env.example .env
npm test           # 225 tests, no Docker or NetSuite needed
npm run demo       # narrated end-to-end walkthrough in the terminal
npm run dev        # API on http://localhost:3000, portal on http://localhost:3000/portal/
```

In the portal, sign in with `dev-cust-acme` and pay an invoice through the simulated hosted checkout.

## Commands

| Command | What it does |
|---|---|
| `npm test` / `npm run test:report` | All tests / tests with JUnit and coverage output (`reports/`, `coverage/`) |
| `npm run ci` | The full quality gate: lint, format, typecheck, secret scan, tests |
| `npm run dev` | Start the middleware with auto-reload |
| `npm run demo` | The scripted portfolio demo (`docs/portfolio/demo-script.md`) |
| `npm run loadtest` | Volume test; results go to `docs/performance/` |
| `npm run build` / `npm start` | Production build and run |
| `npm run smoke` | Smoke-test a running deployment (`BASE_URL`, `OPS_TOKEN`) |
| `npm run db:migrate` | Apply PostgreSQL migrations (`DATABASE_URL`) |
| `npm run sdf:validate` / `sdf:deploy` | SuiteCloud CLI against your NetSuite sandbox |
| `docker compose --profile app up --build` | PostgreSQL plus middleware in containers (`MW_PORT` and `DB_PORT` are configurable) |

See [docs/developer-setup.md](docs/developer-setup.md) for PostgreSQL and NetSuite sandbox setup.

## Repository map

| Path | Contents |
|---|---|
| `middleware/src/` | TypeScript service: `api/` → `application/` → `domain/`, plus `adapters/` and `infrastructure/` |
| `middleware/tests/` | unit, contract, api, reliability and e2e tests |
| `netsuite/` | SDF project (SuiteScripts, Objects), SuiteQL library, SuiteScript test harness |
| `simulators/bank/` | Bank simulator (ACK, settlement, returns, statements) |
| `portal/` | Customer portal prototype and SCMA extension design |
| `test-data/` | Synthetic NetSuite records and bank statements |
| `docs/` | Architecture, processes, NetSuite, API contracts, security, testing, operations, runbooks, portfolio |
| `infrastructure/` | AWS ECS task definition, Prometheus alert rules |
| `.github/workflows/` | CI (every push) and deploy (gated) |

**Start here:**

- [docs/LEARNING_PATH.md](docs/LEARNING_PATH.md): reading order through the code.
- [docs/architecture/overview.md](docs/architecture/overview.md): the architecture and a map of every
  document.
- [plan.md](plan.md): the phase plan.
- [LEARNING_LOG.md](LEARNING_LOG.md): answers to every phase's review questions.

## Branches

`dev → staging → production → main`, promoted by fast-forward only after CI passes. See
[CONTRIBUTING.md](CONTRIBUTING.md).
