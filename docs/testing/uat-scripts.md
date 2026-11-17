# UAT scripts (Phase 12)

Run these in the UAT environment (`staging` branch). Record the result, the evidence (a screenshot,
or the response with its `X-Correlation-Id`) and the tester's initials.

Tokens are listed in `.env.example`. In a real UAT, testers sign in through the identity provider.

| ID | Scenario | Steps | Expected result | Result / evidence |
|---|---|---|---|---|
| UAT-01 | **Payment proposal** | As AP clerk: `GET /ap/proposal?currency=USD&rail=ACH` | 2 vendors, total 1,730.50. BILL-1003 ON_HOLD, BILL-1004 DUPLICATE_BILL, BILL-1005 NOT_DUE, BILL-1006 NOT_APPROVED, BILL-1007 VENDOR_INACTIVE | |
| UAT-02 | **Maker-checker** | Clerk creates the batch. Clerk tries to approve it. Approver approves it. | The clerk's attempt is refused with `MAKER_CHECKER_VIOLATION`, and the audit trail shows the denial. The approver succeeds and the batch is APPROVED. | |
| UAT-03 | **Bank file** | Ops submits the batch. Open `archive/outbound/NSD_*.ach`. | NACHA file: 94-character lines, padded to 10, totals 173050 cents, and no full account numbers anywhere except in the file | |
| UAT-04 | **Rejected entry** | The bank rejects Bolt & Co. Poll. | Acme is Accepted and Bolt is Failed. BILL-1002 is released and appears in the next proposal. | |
| UAT-05 | **Settlement posts to NetSuite** | The bank settles. Poll. | Vendor Payments exist **only now**, and BILL-1001 shows 0.00 remaining | |
| UAT-06 | **ACH return** | The bank returns Bolt (R01). Poll. | The Vendor Payment is voided, BILL-1002 shows 480.50 again, and the instruction is Reversed | |
| UAT-07 | **Customer pays online** | As Acme in `/portal`: select INV-2001, pay with the test card | Status "Payment received – processing", the invoice leaves the open list, and NetSuite has a Customer Payment of 500.00 | |
| UAT-08 | **Refund and duplicate webhook** | AR refunds 50.00. The provider resends the same event. | Refund posted once, invoice shows 50.00 remaining, and the second delivery is ignored | |
| UAT-09 | **Collections** | Run collections for 2026-11-20 | Reminders for INV-2001 and INV-2005, escalation for INV-2003, nothing for disputed INV-2004. A second run sends nothing. | |
| UAT-10 | **Period close** | Payout settles. Import the bank statement. Run reconciliation, then control totals for 2026-11-20 → 25. | Every line is matched, every control check passes, and `balanced: true` | |

*Automated equivalents:* UAT-01 to UAT-06 are in `tests/api/ap-payments.test.ts`. UAT-07 and UAT-08
are in `tests/api/ar-payments.test.ts` and `portal.test.ts`. UAT-09 is in `ar-payments.test.ts`, and
UAT-10 is in `tests/e2e/period-close.test.ts`.

## Change → UAT regression mapping

| If you change… | Re-run |
|---|---|
| Eligibility rules, batch or approval code | UAT-01, 02, 04 |
| NACHA or wire builders, bank adapter | UAT-03, 04, 05, 06 |
| NetSuite adapter or mappings | UAT-05, 06, 07, 10 |
| Webhooks or payment provider adapter | UAT-07, 08 |
| Collections rules or SuiteScripts | UAT-09 |
| Reconciliation rules | UAT-10 |
