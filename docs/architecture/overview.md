# Architecture overview

## System context

```mermaid
flowchart LR
  AP[AP team<br/>maker / checker] --> MW
  AR[AR / collections] --> MW
  FIN[Finance<br/>reconciliation] --> MW
  OPS[Operations] --> MW
  CUST[Business customer] --> PORTAL[Portal<br/>prototype / SCMA] --> MW
  MW[Northstar middleware<br/>Node.js + TypeScript] <-->|SuiteTalk REST, SuiteQL, TBA| NS[(Oracle NetSuite<br/>system of record)]
  NS --- SS[SuiteScripts · SuiteFlow · SDF]
  MW <-->|SFTP: NACHA / ACK / STATUS / camt.053| BANK[Bank]
  MW <-->|hosted checkout + signed webhooks| PROV[Payment provider]
  MW --> DB[(PostgreSQL<br/>integration metadata only)]
```

## Inside the middleware (layers)

```mermaid
flowchart TB
  subgraph api[api/ — HTTP]
    R[routes] --> H[http.ts: context, auth, roles, validation, idempotency, errors]
    SEC[security.ts: headers, rate limit]
  end
  subgraph app[application/ — use cases]
    APS[ap-payments] & ARS[ar-payments] & REC[reconciliation] & COL[collections] & SYNC[master-data-sync]
    WH[webhooks inbox] & BI[bank-inbound] & CT[control-totals]
    JOBS[jobs: retries + DLQ] & OBX[dispatcher: outbox] & IDEM[idempotency] & AUD[audit]
  end
  subgraph domain[domain/ — pure rules, no I/O]
    M[money] & PS[payment-state] & EL[eligibility] & PB[payment-batch] & ARD[ar] & RM[reconciliation matching]
  end
  subgraph adapters[adapters/ — external systems]
    NSA[netsuite: mock · REST · SOAP ref] & BANKA[bank: NACHA, files, vault, statement parsers] & PROVA[payment-provider: simulator, signatures] & SRC[source: mapping]
  end
  subgraph infra[infrastructure/]
    ST[Store: memory · PostgreSQL] & FT[FileTransport: local SFTP]
  end
  api --> app --> domain
  app --> adapters
  app --> infra
```

**Dependency rule:**

- `domain` depends on nothing.
- `application` depends on `domain` and on **ports** (interfaces). Ports are defined in
  `application/ports`, and adapters implement them.
- Only `container.ts` knows which concrete adapter is used. That is what allows a mock, the real
  NetSuite, PostgreSQL or memory to be swapped without touching business code.

## Key flows (with links)

| Flow | Sequence diagram |
|---|---|
| AP: bill → batch → NACHA → bank → NetSuite | `docs/architecture/ap-payments.md` |
| AR: invoice → hosted checkout → webhook → NetSuite → deposit | `docs/api-contracts/webhooks-and-customer-payments.md` |
| Bank statement → reconciliation | `docs/architecture/reconciliation.md` |
| Failure → retry → DLQ → replay; outbox | `docs/architecture/reliability.md` |
| Deployment pipeline | `docs/architecture/deployment.md` |

## Documentation map

| Topic | Document |
|---|---|
| Scope and phases | `plan.md` |
| Decisions | `DECISIONS.md`, `docs/decisions/` |
| Business processes, glossary, exceptions | `docs/business-processes/` |
| Accounting mapping (needs review) | `docs/accounting-mappings/accounting-event-matrix.md` |
| NetSuite: data dictionary, scripts, workflows, searches, SDF | `docs/netsuite/` |
| API (OpenAPI) | `middleware/openapi.yaml` (served at `/api/v1/openapi.yaml`) |
| Field mapping, webhooks, sample files | `docs/api-contracts/` |
| Security, threat model, access control | `docs/architecture/security.md` |
| Performance | `docs/performance/report.md` |
| Testing, UAT, defects | `docs/testing/` |
| Operations: SLOs, alerts, postmortems | `docs/operations/` |
| Runbooks | `docs/runbooks/` |
| What is real and what is simulated | `KNOWN_LIMITATIONS.md` |
| Learning path through the code | `docs/LEARNING_PATH.md` |
| Portfolio: demo, skills matrix, interview prep | `docs/portfolio/` |
