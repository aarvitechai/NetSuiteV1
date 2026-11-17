# ADR-0001: NetSuite is the accounting system of record

- **Status:** Accepted
- **Date:** 2026-11-17
- **Phase:** 0

## Context

The platform connects several systems: NetSuite (the ERP), a Node.js middleware, payment-provider
sandboxes, bank sandboxes (SFTP files), and a customer portal. Each one stores some data about vendors,
customers, bills, invoices and payments.

If more than one system is allowed to be the "truth" for accounting data, the numbers drift apart.
Finance then cannot close the period, because nobody can say which balance is right.

## Decision

1. **NetSuite owns accounting data and its GL impact.** That covers vendors, customers, vendor bills,
   invoices, vendor payments, customer payments, deposits and journal entries.
2. **The middleware owns integration metadata only.** That covers integration jobs, idempotency keys,
   webhook receipts, outbox and inbox messages, payment batch working state, file checksums,
   reconciliation suggestions and audit events. It is **not** a second general ledger.
3. **Providers and banks own the execution facts.** They decide whether money actually moved
   (acceptance, settlement, returns). The middleware records their references and sends the
   _approved_ results to NetSuite.
4. The middleware **never creates an accounting transaction in NetSuite on its own initiative**.
   It does so only when two things are true:
   - a documented mapping exists (`docs/accounting-mappings/`), and
   - the business event is verified: a settled status, an authenticated webhook, or an approved
     reconciliation match.

## Consequences

- Every middleware record that relates to accounting stores a **NetSuite reference**: an internal ID
  or an external ID.
- Reports on balances (aging, open AP) are run **in NetSuite**, through saved searches and SuiteQL,
  and never from the middleware database.
- If NetSuite is unavailable, the middleware queues work and retries later. It does not
  "temporarily" keep its own balances.
- In this learning project, NetSuite is replaced by a **clearly labelled in-memory simulator**
  (`MockNetSuiteAdapter`) wherever no sandbox is available. The simulator follows the same
  ownership rules.
