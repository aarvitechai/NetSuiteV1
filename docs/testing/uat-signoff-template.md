# UAT sign-off: Northstar AP/AR & Banking Payments Platform

| Field | Value |
|---|---|
| Release / commit | `__________` (git SHA on `staging`) |
| UAT period | from ____ to ____ |
| Environment | staging (NetSuite sandbox: ☐ yes ☐ no, simulators) |

## Results

| Check | Result |
|---|---|
| UAT-01 … UAT-10 executed (`docs/testing/uat-scripts.md`) | ☐ all passed ☐ exceptions listed below |
| Automated suite (`npm run ci`) green on this commit | ☐ |
| Control totals `balanced: true` for the UAT period (attach the JSON) | ☐ |
| Reconciliation report: 0 exceptions, 0 unreconciled transactions | ☐ |
| DLQ empty, outbox empty (`/ops/dashboard`) | ☐ |
| Open defects of severity 1 or 2 | ☐ none |
| Accounting mappings reviewed by a qualified accountant | ☐ (name and date) |

## Exceptions and accepted risks

| # | Description | Accepted by | Expires |
|---|---|---|---|
| | | | |

## Sign-off

| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| AP lead | | ☐ approve ☐ reject | | |
| AR lead | | ☐ approve ☐ reject | | |
| Controller / finance | | ☐ approve ☐ reject | | |
| Integration lead | | ☐ approve ☐ reject | | |

Production promotion (`staging → production`) is allowed **only** with every approval above.
