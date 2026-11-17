# Portfolio demo: talk track (20–30 minutes)

Run `npm run demo` for the automated version of every step below. For a live, clickable version, run
`npm run dev` and open <http://localhost:3000/portal/>.

| # | Minutes | Show | Say (key points) |
|---|---|---|---|
| 1 | 3 | `docs/architecture/overview.md` diagram | "NetSuite is the system of record for money. The middleware orchestrates. It owns integration *metadata*, never balances (ADR-0001)." |
| 2 | 4 | Demo step 2: proposal and exclusions, maker-checker | "Eleven eligibility rules, each with a business reason. The maker cannot approve their own batch. We compare *people*, not tokens." |
| 3 | 3 | Demo step 3: NACHA lines | "94-character records, control totals and an entry hash. The bank recomputes them. Account numbers come from a vault token, only at file-build time." |
| 4 | 3 | Demo step 4: ACK, then settlement, then the return | "Accepted is not paid. The NetSuite Vendor Payment is created only at settlement. An R01 return voids it and reopens the bill." |
| 5 | 3 | Portal: invoice, hosted checkout | "Card data never touches us: hosted checkout and a strict schema. The portal shows 'processing' versus 'completed'." |
| 6 | 2 | Demo step 6: duplicate webhook | "Signature verified, stored under the event ID (inbox), acknowledged fast, processed through the outbox. A second delivery does nothing." |
| 7 | 3 | Demo step 7: camt.053 import | "Deterministic matching with confidence scores. Anything uncertain goes to a human, and the bank fee is correctly an exception." |
| 8 | 3 | Audit trail, `/ops/dashboard`, control totals | "One correlation ID per story. Nine control checks prove nothing was lost or duplicated." |
| 9 | 3 | CI run on GitHub, `Dockerfile`, `deploy.yml`, SDF guide | "Every push: lint, types, a secret scan, 225 tests including PostgreSQL, and a container smoke test. Production needs approval." |
| 10 | 3 | Demo step 9 plus `docs/runbooks/integration-incidents.md` | "NetSuite outage: bounded retries, then the DLQ, then replay with the original correlation ID. Idempotent, so no duplicates." |

## Portfolio statement (say this explicitly)

| What | Status |
|---|---|
| Middleware, reliability patterns, files, reconciliation, portal prototype, CI | **Ran for real.** 225 tests, CI green on GitHub, the Docker image smoke-tested, and the PostgreSQL contract run against real PostgreSQL. |
| NetSuite | **Simulated** by `MockNetSuiteAdapter`. The REST adapter and SuiteScripts are written to the documented APIs and tested with fakes. **Not yet run against a sandbox.** |
| Bank and payment provider | **Simulated** |
| SuiteFlow workflows, SCMA extension, cloud deployment | **Design and documentation.** The deploy pipeline exists but is disabled. |

Never describe the simulated parts as production integrations. Interviewers respect clarity more than
inflated claims.
