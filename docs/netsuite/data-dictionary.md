# NetSuite data dictionary (Phase 2)

The SDF definitions are in `netsuite/src/Objects/`. Scripts refer to fields **only** through
`lib/nsd_constants.js`, and a test checks that the two stay in sync.

## Account setup (learning account)

These are configured in the NetSuite UI. They cannot be fully expressed in SDF.

| Area | Setting | Why |
|---|---|---|
| Enable Features | Custom Records, Server/Client SuiteScript, SuiteFlow, REST Web Services, SOAP Web Services, Token-Based Authentication, SuiteQL (via REST) | Required by Phases 3–6 |
| Currencies | USD (base), EUR | Lets us test the multi-currency eligibility rules |
| Accounting periods | Monthly, for FY2026 | Lets us test closed-period errors |
| Accounts | Operating Bank (USD), EUR Bank, Undeposited Funds, Merchant Fees (expense), AP, AR | Needed for the accounting event matrix |
| Payment methods | ACH, Wire, Virtual Card, Online Card (provider) | |
| Roles | *NSD Integration* (web services only, least privilege), *NSD AP Clerk*, *NSD AP Approver*, *NSD AR Clerk* | Separation of duties |

## Standard records used

| Record | Script ID | Owned by | Key fields we rely on |
|---|---|---|---|
| Vendor | `vendor` | NetSuite (synced from the middleware master) | `externalid`, `companyname`, `currency`, `isinactive` |
| Customer | `customer` | NetSuite | `externalid`, `companyname`, `email`, `currency` |
| Vendor Bill | `vendorbill` | NetSuite | `tranid` (vendor invoice no.), `entity`, `duedate`, `approvalstatus`, `amountremaining` |
| Vendor Payment | `vendorpayment` | NetSuite (created by the middleware at *Settled*) | `entity`, `apply` sublist, `externalid` = payment instruction ID |
| Invoice | `invoice` | NetSuite | `entity`, `duedate`, `amountremaining` |
| Customer Payment | `customerpayment` | NetSuite (created by the middleware on webhook success) | `customer`, `apply` sublist, `externalid` |
| Deposit | `deposit` | NetSuite | Settlement net amount and fee lines |
| Journal Entry | `journalentry` | NetSuite | Only for policy-approved adjustments |

## Custom transaction body fields (`custbody_nsd_*`)

| Field ID | Type | Applies to | Purpose |
|---|---|---|---|
| `custbody_nsd_ext_pay_ref` | Text | Purchase, Sale | The middleware payment instruction ID |
| `custbody_nsd_provider_ref` | Text | Purchase, Sale | The bank or provider reference |
| `custbody_nsd_int_status` | Text | Purchase, Sale | `PENDING` / `SYNCED` / `ERROR` |
| `custbody_nsd_idem_key` | Text | Purchase, Sale | The idempotency key of the create call |
| `custbody_nsd_correlation_id` | Text | Purchase, Sale | Trace ID |
| `custbody_nsd_error_detail` | Text area | Purchase, Sale | The last error. Must never hold secrets or card data. |
| `custbody_nsd_pay_in_progress` | Checkbox | Purchase | The bill is in a submitted batch, which prevents double payment |
| `custbody_nsd_pay_hold` | Checkbox | Purchase | Manual AP hold |
| `custbody_nsd_pay_batch_ref` | Text | Purchase | The batch that paid the bill |
| `custbody_nsd_collection_stage` | Text | Sale | `NONE` → `REMINDER_1` → `REMINDER_2` → `ESCALATED` |
| `custbody_nsd_dispute` | Checkbox | Sale | Pauses collections |

> Vendor Payment and Customer Payment have their own "applies to" flags. Verify them in the UI after you
> deploy, then run `suitecloud object:import` to capture them in source control.

## Custom entity fields (`custentity_nsd_*`)

| Field ID | Applies to | Purpose |
|---|---|---|
| `custentity_nsd_ext_id_src` | Vendor, Customer | Which system owns the master record |
| `custentity_nsd_pay_method` | Vendor | ACH / WIRE / VCARD |
| `custentity_nsd_bank_token` | Vendor | A **token** for the bank details, which are held by the provider. The raw account number is never stored. |

## Custom records

| Record | Purpose | Key fields |
|---|---|---|
| `customrecord_nsd_pay_batch` | AP payment batch | batch reference (immutable), rail, currency, total, count, status, maker, checker, file SHA-256, bank reference |
| `customrecord_nsd_int_log` | Integration log, visible to admins | correlation ID, operation, status, error code and detail, related record, idempotency key |
| `customrecord_nsd_recon_match` | Reconciliation match | bank line reference, transaction reference, rule, confidence, status, reviewer, amount |

## External IDs

Every record that the middleware creates or syncs gets an `externalid`, for example `VEND-ACMESUP`,
`BILL-1001`, or `PI-<uuid>` for payments.

**Why:**

- SuiteTalk REST can address a record as `/record/v1/vendor/eid:VEND-ACMESUP`, so an *upsert* needs no
  internal-ID lookup.
- NetSuite rejects a second record with the same external ID. That turns a retried create into a
  conflict rather than a duplicate.

## Middleware or NetSuite: where does each piece of data live?

| Data | Lives in | Reason |
|---|---|---|
| Balances, GL, transactions | NetSuite | System of record |
| Idempotency keys, webhook receipts, job state, outbox and inbox | Middleware DB | Integration plumbing, high volume and short-lived |
| Full audit of API calls | Middleware DB (plus a summary in `customrecord_nsd_int_log`) | Volume. NetSuite only holds what admins need. |
| Bank account numbers | Provider vault only (NetSuite holds the token) | Minimises exposure of sensitive data |

## Retention (proposed, needs review)

| Data | Retention |
|---|---|
| Idempotency records | 30 days |
| Webhook receipts | 13 months |
| Audit events and bank files | 7 years (typical for financial records; confirm locally) |
