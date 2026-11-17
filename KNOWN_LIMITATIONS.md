# Known limitations

This file is a plain statement of what is real, what is simulated, and what is a design only.
Use it to describe the project honestly, for example in interviews.

## Ran against a real NetSuite sandbox

- Nothing yet. No sandbox credentials were available while this was built.
- The PostgreSQL store **was** run against a real PostgreSQL 16, through the contract tests.

## Simulated (runs locally, clearly labelled)

- **NetSuite.** `MockNetSuiteAdapter` keeps records in memory.

## Design or prototype only

- None yet.

## Not in scope

- Real money and live banks.
- Card numbers or CVV.
- PCI DSS compliance claims.
- Production accounting policy.

## SDF objects (Phase 2)

- The object XML in `netsuite/src/Objects/` was written by hand following SDF conventions. It has
  **not** been validated against a real account.
- Before deploying, run `suitecloud project:validate`. After the first deploy, re-import the objects
  with `suitecloud object:import` to pick up account-specific attributes.
- The saved-search status codes (`VendBill:A`, `CustInvc:A`) must be verified in the target account.

## SuiteScripts (Phase 3)

- All six scripts are tested only against **fake `N/*` modules** (`netsuite/tests/harness`). They
  have not run inside NetSuite.
- Behaviour that needs a sandbox to confirm:
  - governance consumption
  - `getFields()` on XEDIT
  - formula column naming (`formulanumeric`) in Map/Reduce values
  - deployment XML attributes

## SuiteFlow and SuiteQL (Phase 4)

- The workflows are **specifications only**. They must be built in the UI and then imported into SDF.
- The SuiteQL field names (`foreignamountremaining`, `approvalstatus = 2`, …) follow the NetSuite
  Records Catalog. They have not been executed against an account.

## NetSuite adapters (Phase 5)

- `NetSuiteRestAdapter` is tested only against a fake `fetch`. Things that need sandbox
  verification:
  - request body shapes (`apply.items`, `cashBack`, `currency.refName`)
  - SuiteQL field names
  - duplicate-externalId error text
- `voidVendorPayment` over REST flags the payment for a manual void. The void itself is a manual
  runbook step.
- The SOAP envelope builder is reference material only. No SOAP calls are made.
