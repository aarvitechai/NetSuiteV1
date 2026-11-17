# Glossary

| Term                         | Meaning                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **AP (Accounts Payable)**    | Money Northstar owes its vendors. It is a liability.                                                        |
| **AR (Accounts Receivable)** | Money customers owe Northstar. It is an asset.                                                              |
| **GL (General Ledger)**      | The master set of accounts every transaction posts to.                                                      |
| **Debit / Credit**           | The two sides of every journal entry. Total debits always equal total credits.                              |
| **Vendor Bill**              | A NetSuite transaction recording a vendor invoice (Dr expense, Cr AP).                                      |
| **Vendor Payment**           | A NetSuite transaction that pays one or more bills (Dr AP, Cr bank).                                        |
| **Invoice**                  | A NetSuite transaction billing a customer (Dr AR, Cr revenue).                                              |
| **Customer Payment**         | A NetSuite transaction that applies cash to invoices (Dr Undeposited Funds, Cr AR).                         |
| **Deposit**                  | Moves money from Undeposited Funds into a bank account.                                                     |
| **Undeposited Funds**        | A holding account for received payments that are not yet banked.                                            |
| **Maker-checker**            | One person prepares an action and a _different_ person approves it. A fraud control.                        |
| **Payment batch**            | A group of payment instructions sent together, for example in one NACHA file.                               |
| **ACH / NACHA**              | ACH is the US bank-to-bank batch network. NACHA is the file format it uses (94-character records).          |
| **ACH return**               | The bank sends an ACH payment back, for example R01 (insufficient funds) or R03 (no account).               |
| **Wire**                     | A same-day, individually sent, generally irrevocable bank transfer.                                         |
| **Virtual card**             | A single-use card number generated to pay one vendor invoice.                                               |
| **Settlement**               | The point at which money actually moves between accounts.                                                   |
| **Reconciliation**           | Matching internal records to the bank statement so both agree.                                              |
| **camt.053**                 | ISO 20022 XML format for an end-of-day bank statement.                                                      |
| **Idempotency key**          | A unique key per operation, so that repeating the request does not repeat its effect.                       |
| **Correlation ID**           | An ID attached to every log line and message of one business flow, for tracing.                             |
| **External ID**              | Our own unique identifier, stored on a NetSuite record so we can find or upsert it without its internal ID. |
| **Webhook**                  | An HTTP call that a provider makes _to us_ when something happens.                                          |
| **Outbox / Inbox**           | Tables that make sending and receiving messages reliable and duplicate-safe.                                |
| **DLQ (dead-letter queue)**  | Where a message goes after it has failed too many times, waiting for a human.                               |
| **SuiteScript**              | NetSuite's JavaScript API that runs inside NetSuite.                                                        |
| **SuiteFlow**                | NetSuite's point-and-click workflow engine.                                                                 |
| **SuiteQL**                  | NetSuite's SQL dialect for querying records.                                                                |
| **SuiteTalk**                | NetSuite's web service APIs (REST and SOAP).                                                                |
| **SDF**                      | SuiteCloud Development Framework. It deploys scripts and custom objects from source control.                |
| **Governance**               | NetSuite's usage-unit limits on how much work one script execution may do.                                  |
| **SCMA**                     | SuiteCommerce MyAccount, NetSuite's customer self-service portal.                                           |
