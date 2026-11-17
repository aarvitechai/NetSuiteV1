# Skills evidence matrix

> The plan's "JD Coverage Matrix" (§9) was empty in the source document, and the job description text
> itself was not included. The matrix below maps **the responsibilities the plan is built around** to
> concrete evidence in this repo. **Next step:** paste the real JD bullets into the first column, and
> re-map them.

| Responsibility / skill | Evidence in this repo | Honest status |
|---|---|---|
| SuiteScript 2.x: User Event, Client, Scheduled, Map/Reduce, Suitelet, RESTlet | `netsuite/src/FileCabinet/SuiteScripts/northstar/*`, 43 tests in `netsuite/tests` | Tested against a harness. Not yet run in a sandbox. |
| Governance-aware, restart-safe scripting | `nsd_ss_stale_payments.js` (reschedules itself), `nsd_mr_collections.js` (idempotent), `docs/netsuite/suitescript-guide.md` | Logic tested. Governance numbers need a sandbox. |
| SuiteFlow approval and collections workflows | `docs/netsuite/workflows.md` (states, actions, test evidence plan) | Design only |
| Saved searches and SuiteQL | `lib/nsd_searches.js`, `netsuite/suiteql/*.sql`, the injection-safe `bindSuiteQL` | Field names follow the Records Catalog. Not executed. |
| Custom records and fields, data modelling | `netsuite/src/Objects/*.xml`, `docs/netsuite/data-dictionary.md` | Hand-written SDF XML, needs `project:validate` |
| SDF and source-controlled NetSuite deployment | `netsuite/` project, `docs/netsuite/sdf-deployment.md`, SDF consistency tests | Not yet deployed |
| SuiteTalk REST and SOAP integration, TBA (OAuth 1.0a) | `adapters/netsuite/rest-netsuite.ts`, `oauth1.ts`, `soap-envelope.ts` | Tested against a fake fetch |
| Node.js / TypeScript middleware architecture | Layered `middleware/src` (ports and adapters), `docs/architecture/overview.md` | ✅ Runs |
| REST API design and OpenAPI | `middleware/openapi.yaml`, versioned `/api/v1`, consistent errors | ✅ |
| AP automation: vendor payments, batches, maker-checker | `application/ap-payments.ts`, `tests/api/ap-payments.test.ts` | ✅ Against simulators |
| Bank file formats (NACHA, wire), SFTP | `adapters/bank/nacha.ts` (validated control totals), `payment-files.ts`, `file-transport.ts` | ✅ Simulator. Not bank-certified. |
| AR: online payments, refunds, collections | `application/ar-payments.ts`, `collections.ts`, `tests/api/ar-payments.test.ts` | ✅ Simulator |
| Webhooks: signature verification, idempotent processing | `application/webhooks.ts`, `webhook-signature.ts`, inbox and outbox | ✅ |
| Bank reconciliation (CSV, camt.053), exception handling | `adapters/bank/statement-parsers.ts`, `domain/reconciliation.ts`, `application/reconciliation.ts` | ✅ |
| Accounting knowledge (AP, AR, GL, settlement, fees) | `docs/accounting-mappings/accounting-event-matrix.md`, control totals | Needs review by an accountant |
| Customer self-service portal (SuiteCommerce MyAccount) | `portal/local-prototype`, `docs/portal/ux-spec.md`, `portal/scma-extension/README.md` | Prototype. SCMA is design only. |
| Reliability: idempotency, retries, DLQ, outbox | `application/{idempotency,retry,jobs,dispatcher}.ts`, `tests/reliability` | ✅ |
| Security: least privilege, secrets, PCI-aware design | `docs/architecture/security.md` (STRIDE, access matrix), redaction tests, CSP | ✅ Design and tests. No compliance claim. |
| Performance and high-volume processing | `scripts/load-test.ts`, `docs/performance/report.md` (found and fixed a 64× bottleneck) | ✅ Middleware only |
| Testing: unit, contract, end to end, UAT | 225 tests, `docs/testing/*`, control totals | ✅ |
| CI/CD and cloud deployment (AWS / Azure) | `.github/workflows/*`, `Dockerfile`, `infrastructure/aws/task-definition.json`, `docs/architecture/deployment.md` | CI ✅ green on GitHub. Deploy is gated and not enabled. |
| Observability: logs, metrics, SLOs, alerts | `shared/{logger,metrics}.ts`, `/metrics`, `docs/operations/*`, `infrastructure/monitoring/prometheus-alerts.yml` | ✅ |
| Operations: runbooks, incident response | `docs/runbooks/*`, `docs/operations/postmortem-template.md` | ✅ |
| Mentoring and documentation | Comments throughout, `docs/LEARNING_PATH.md`, `LEARNING_LOG.md` | ✅ |
| Agile delivery and change control | Phase-by-phase commits, branch promotion, `DECISIONS.md`, defect log | ✅ |
