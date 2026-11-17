# Saved search catalogue

The searches are defined in code in `netsuite/src/FileCabinet/SuiteScripts/northstar/lib/nsd_searches.js`.
`saveAll()` creates them in an account. The SuiteQL equivalents are in `netsuite/suiteql/`.

| Search ID | Title | Record | Filters | Columns | Intended users |
|---|---|---|---|---|---|
| `customsearch_nsd_unpaid_bills` | NSD AP - Unpaid Bills Eligible for Payment | Vendor Bill | mainline; status Open; not on hold; not in progress | tranid, vendor, dates, currency, amount remaining, externalid | AP clerk (maker), Map/Reduce payment proposal |
| `customsearch_nsd_overdue_invoices` | NSD AR - Overdue Invoices | Invoice | mainline; status Open; due date before today; not disputed | tranid, customer, due date, remaining, currency, collection stage | AR clerk, collections workflow |
| `customsearch_nsd_pending_batches` | NSD Ops - Pending Payment Batches | Payment Batch (custom) | status Submitted or Accepted | batch ref, total, status, created | Operations |
| `customsearch_nsd_failed_integrations` | NSD Ops - Failed Integrations | Transaction | mainline; integration status = ERROR | type, tranid, error, correlation ID, modified | Operations / support |
| `customsearch_nsd_unreconciled` | NSD Finance - Unreconciled Bank Lines | Recon Match (custom) | status ≠ APPROVED | bank line, amount, rule, confidence | Finance / controller |

**Why `mainline = T`?** A transaction search returns one row per transaction *line* by default.
`mainline = T` keeps only the header row, so you get one row per bill.
