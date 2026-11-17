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

## AP payments (Phase 7)

- The NACHA output follows the public record layout. It has **not** been certified by any bank.
  Bank-specific rules (prenotes, holidays, cut-offs, file ID modifier sequencing) are not implemented.
- The wire CSV and virtual-card JSONL formats are simplified stand-ins for real bank and provider
  formats (for example ISO 20022 pain.001).
- Bank ACK and status files are simplified JSON. Real banks send NACHA return files, pain.002 or
  camt.054.
- SFTP is a local folder (`LocalFolderSftp`). There is no real SSH transport.
- The bank vault is simulated (`SimulatedVault`). It derives fake account numbers.

## AR payments (Phase 8)

- The payment provider is a simulator (`SimulatedPaymentProvider`). The webhook envelope and
  signature scheme follow common industry practice but match no specific provider.
- Chargebacks are booked as a Customer Refund that reopens the invoice. **This accounting policy needs
  review** (accounting-event-matrix R5).
- Settlement gross amounts ignore refunds that happen before payout (this is a simplification).
- Emails are recorded by `RecordingNotifier`. No real email is sent.
- Webhook processing is asynchronous inside the same process. Phase 11 adds a durable queue or
  outbox worker.

## Customer portal (Phase 9)

- `portal/local-prototype` is a **local prototype**. It is not a SuiteCommerce MyAccount extension.
- The SCMA extension exists only as a design (`portal/scma-extension/README.md`).
- Sign-in uses static test tokens. A real portal would use NetSuite shopper sessions, or OIDC.
- The hosted checkout page is simulated (`/dev/checkout`) and is disabled in production.
