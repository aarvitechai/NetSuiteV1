# Known limitations

This file is a plain statement of what is real, what is simulated, and what is a design only.
Use it to describe the project honestly, for example in interviews.

## Ran against a real NetSuite sandbox

- Nothing yet. No sandbox credentials were available while this was built.

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
