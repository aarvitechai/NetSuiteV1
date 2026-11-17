# Accounting event matrix

> ⚠️ **Needs review.** A qualified accounting stakeholder must review this matrix before it is relied on.
> The entries describe _standard_ NetSuite behaviour for these transaction types, for learning
> purposes only. Account names are examples.

In NetSuite, most of these journal lines are created **automatically** by the transaction. A Vendor
Bill posts to AP, for example, so the middleware never writes these lines itself. The middleware's job
is to create the right **transaction** at the right **moment**.

| #   | Business event                    | Trigger state               | NetSuite transaction                                                                | Debit                                   | Credit                   | Example (USD)                         |
| --- | --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ | ------------------------------------- |
| A1  | Vendor bill approved              | Bill approved (SuiteFlow)   | Vendor Bill                                                                         | Expense / Inventory                     | Accounts Payable         | Dr Supplies 1,000.00 / Cr AP 1,000.00 |
| A2  | Vendor payment settled            | `Settled`                   | Vendor Payment (applied to bill)                                                    | Accounts Payable                        | Bank (Operating)         | Dr AP 1,000.00 / Cr Bank 1,000.00     |
| A3  | Vendor payment returned           | `Returned → Reversed`       | Void the Vendor Payment (reversing journal)                                         | Bank                                    | Accounts Payable         | Dr Bank 1,000.00 / Cr AP 1,000.00     |
| R1  | Customer invoiced                 | Invoice approved            | Invoice                                                                             | Accounts Receivable                     | Revenue                  | Dr AR 500.00 / Cr Revenue 500.00      |
| R2  | Online payment succeeded          | Webhook `payment.succeeded` | Customer Payment → _Undeposited Funds_                                              | Undeposited Funds                       | Accounts Receivable      | Dr UF 500.00 / Cr AR 500.00           |
| R3  | Provider settlement (net of fees) | Settlement file             | Deposit with a fee line                                                             | Bank 485.20 **and** Merchant Fees 14.80 | Undeposited Funds 500.00 | Gross 500.00 − fee 14.80 = net 485.20 |
| R4  | Refund                            | Webhook `refund.succeeded`  | Customer Refund                                                                     | Accounts Receivable                     | Bank / Undeposited Funds | Dr AR 50.00 / Cr Bank 50.00           |
| R5  | Chargeback / return               | Webhook `payment.returned`  | Reverse the payment, or a journal to a disputes account (**needs policy decision**) | AR (or Chargebacks)                     | Bank                     | —                                     |

## Why the fees are separate (R3)

The customer paid 500.00 and owes nothing more, so AR is fully cleared. The provider kept 14.80 as its
fee, which is Northstar's expense. Only the net 485.20 arrives at the bank.

Booking the fee on its own line lets the bank deposit match the bank statement exactly, and still keeps
the customer's balance correct.

## Open questions for the accounting reviewer

1. Are chargebacks reversed against AR, or booked to a separate disputes account?
2. At which cut-off time does a settlement belong to a period?
3. When a payment is in a foreign currency, which exchange rate applies: transaction date or
   settlement date?
