# Automated test report

Generated with `npm run test:report`, which writes JUnit XML to `reports/junit.xml` and an HTML
coverage report to `coverage/`. Both are git-ignored.

**Run:** 2026-11-17 on Node 24.13.

## Summary

| Metric | Value |
|---|---|
| Test files | 28 |
| Tests passed | **225** |
| Tests failed | 0 |
| Skipped | 1 (the PostgreSQL contract runs only with `TEST_DATABASE_URL`) |
| PostgreSQL contract run (PostgreSQL 16 in Docker) | **11 / 11 passed** |
| Statement coverage (middleware) | 86.1% |
| Branch coverage | 72.5% |
| Function coverage | 86.2% |
| Line coverage | 88.7% |

SuiteScript files run inside a sandboxed `vm` context (`netsuite/tests/harness`), so V8 coverage does
not attribute them. Their behaviour is covered by 43 SuiteScript tests.

## Tests per suite

| Suite | Tests |
|---|---|
| api/ap-payments | 12 |
| api/ar-payments | 17 |
| api/foundation | 11 |
| api/integration | 8 |
| api/portal | 7 |
| api/reconciliation | 7 |
| contract/master-data-mapping | 9 |
| contract/netsuite-parity | 1 |
| e2e/period-close | 2 |
| reliability/outbox | 3 |
| reliability/security | 7 |
| unit (12 files) | 82 (+1 skipped) |
| netsuite (4 files) | 43 |

## End-to-end evidence

`tests/e2e/period-close.test.ts` runs the whole period:

- AP batch, rejection paths, ACH return
- AR payments, refund, payout
- camt.053 statement and reconciliation

It asserts every control total:

| Check | Left | Right | OK |
|---|---|---|---|
| AP-1 instructions = bill applications | 1,730.50 | 1,730.50 | ✅ |
| AP-2 instructions = NetSuite Vendor Payments | 1,730.50 | 1,730.50 | ✅ |
| AP-3 NetSuite Vendor Payments = bank debits | 1,730.50 | 1,730.50 | ✅ |
| AP-4 voided payments = return credits | 480.50 | 480.50 | ✅ |
| AR-1 payments succeeded = NetSuite Customer Payments | 3,900.00 | 3,900.00 | ✅ |
| AR-2 provider refunds = NetSuite refunds | 50.00 | 50.00 | ✅ |
| AR-3 gross − fees = net | 3,786.30 | 3,786.30 | ✅ |
| AR-4 settlement net = NetSuite Deposits | 3,786.30 | 3,786.30 | ✅ |
| AR-5 Deposits = bank credits | 3,786.30 | 3,786.30 | ✅ |

The negative test ("a Vendor Payment posted without a bank debit breaks AP-3") proves that the checks
**detect** imbalances. They do not just pass.
