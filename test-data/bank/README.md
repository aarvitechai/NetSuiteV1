# Synthetic bank statements

These are sample inputs for the reconciliation engine. Each line is designed to hit one scenario.
The references match what the simulator produces. Real end-to-end runs use files that
`BankSimulator.statement()` generates.

| Line | Scenario | Expected result |
|---|---|---|
| ACH debit with a trace-number reference | Exact match | `EXACT_REF`, auto-approved |
| One ACH debit for a whole batch | One-to-many | `GROUP_REF`, auto-approved |
| Payout credit with the settlement id, at the net amount | Exact match (Deposit) | `EXACT_REF` |
| Payout credit with the settlement id, but the fee was deducted again | Partial / fee deduction | `RECON_AMOUNT_MISMATCH` exception |
| The same bank reference in two files | Duplicate | Skipped (`duplicates: 1`) |
| ACH return credit | Return | Matches the reversal of the voided Vendor Payment |
| Bank service fee | Unmatched | `RECON_UNMATCHED` exception |
| Refund debit without a reference | Amount and date only | `AMOUNT_DATE`, suggested (needs approval) |
