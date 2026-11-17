# Field mapping specification (Phase 6)

The code is in `middleware/src/adapters/source/master-data-mapper.ts`. The contract tests are in
`middleware/tests/contract/master-data-mapping.test.ts`. If you change one, change the other.

## Vendor: upstream procurement system → domain → NetSuite

| Upstream field | Rule | Domain field | NetSuite REST field (vendor) |
|---|---|---|---|
| `vendor_code` | Required, `^[A-Z0-9][A-Z0-9_-]{1,63}$` | `externalId` | `externalId` (also the URL key `eid:`) |
| `legal_name` | Required, trimmed, 1–83 characters | `companyName` | `companyName` |
| `ccy` | ISO 4217 | `currency` | `currency.refName` |
| `status` | `ACTIVE` / `INACTIVE` | `isInactive` (`INACTIVE` → true) | `isInactive` |
| `pay_method` | `ACH` / `WIRE` / `VCARD` | `paymentRail` | `custentity_nsd_pay_method` |
| `bank_ref` | **Must be a vault token** `tok_…` | `bankToken` | `custentity_nsd_bank_token` |
| `routing_number` | Optional, 9 digits | `routingNumber` | *(not sent; used only for the NACHA file)* |
| — | Constant | — | `custentity_nsd_ext_id_src = MIDDLEWARE` |

## Customer: upstream CRM → domain → NetSuite

| Upstream field | Rule | Domain field | NetSuite REST field (customer) |
|---|---|---|---|
| `customer_code` | Same pattern as `vendor_code` | `externalId` | `externalId` |
| `name` | 1–83 characters | `companyName` | `companyName` |
| `ccy` | ISO 4217 | `currency` | `currency.refName` |
| `billing_email` | Valid email, lower-cased | `email` | `email` |

## Bills and invoices: NetSuite → domain (read path, SuiteQL)

| SuiteQL column | Domain field | Notes |
|---|---|---|
| `t.externalid` | `externalId` | |
| `v.externalid` / `c.externalid` | `vendorExternalId` / `customerExternalId` | Joined, so callers never see internal IDs |
| `t.tranid` | `tranId` | For bills, this is the vendor's invoice number |
| `TO_CHAR(t.duedate,'YYYY-MM-DD')` | `dueDate` | Formatted in SQL, so it does not depend on user date preferences |
| `t.foreigntotal` / `t.foreignamountremaining` | `total` / `amountRemaining` | Transaction currency, as strings |
| `t.approvalstatus` (`2`) | `approvalStatus = APPROVED` | Verify the code values in your account |
| `custbody_nsd_pay_hold` / `custbody_nsd_pay_in_progress` | `onHold` / `paymentInProgress` | `'T'` → true |

## Error behaviour

| Situation | Result in the sync report | Goes to the DLQ? |
|---|---|---|
| A row fails validation | `INVALID`, with the field errors | No. The upstream system must fix the data. |
| NetSuite 429 or 5xx, then success on retry | `CREATED` / `UPDATED` | No |
| NetSuite 429 or 5xx on every attempt | `FAILED` (`NETSUITE_UNAVAILABLE`) | **Yes.** Replay after the outage. |
| NetSuite business error (400) | `FAILED` (`NETSUITE_BUSINESS_ERROR`) | **Yes.** Fix the data, then replay or discard. |
