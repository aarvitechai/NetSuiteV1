# Runbook: AP payment batches

Find the batch with `GET /api/v1/payment-batches/{id}`. Its audit trail is at
`GET /api/v1/audit?entityType=payment_batch&entityId={id}`. Every response carries an
`X-Correlation-Id` header. Use it to search the logs.

## Batch stuck in SUBMITTED (no ACK from the bank)

1. Check the batch's `file.transmitted`. If it is `false`, the file never reached SFTP. Call
   `POST /payment-batches/{id}/submit` again. This resends the **archived** bytes unchanged, so it is
   safe.
2. If it is `true`, check that the file left `outbound/` (the bank picked it up). If it is still
   there, contact the bank or check the SFTP connection.
3. Do **not** create a new batch for the same bills. They are flagged as in progress, and a second
   batch could cause a double payment if the first file is processed late.
4. The nightly NetSuite scheduled script `nsd_ss_stale_payments` raises a warning after 5 days.

## File rejected by the bank (batch FAILED)

- The bills are released automatically (the `payment in progress` flag is cleared).
- Read the ACK `reason`. Fix the cause, which is usually vendor bank data (ask the vendor) or the file
  header configuration (`COMPANY_ID`, `ORIGIN_ROUTING`).
- Create a new batch. A maker and a checker must approve it again.

## Entry rejected (instruction Failed, rest of the batch fine)

- Its bill is released and appears in the next proposal.
- Ask the vendor to confirm their bank details. Update the vault token in the vendor master, which
  syncs to NetSuite.

## ACH return (instruction Returned → Reversed)

- The middleware voids the NetSuite Vendor Payment and reopens the bill automatically.
- Look up the `returnCode`: R01 means insufficient funds (rare for credits), R02 account closed,
  R03 no account, R04 invalid account.
- Contact the vendor for new bank details **before** paying again.
- Check the DLQ. If the void failed (for example because NetSuite was down), replay
  `netsuite.vendor_payment.reverse`.

## Settled, but no NetSuite Vendor Payment

- `GET /api/v1/dead-letters`. Look for topic `netsuite.vendor_payment.post`.
- Common causes: a closed accounting period (finance must reopen it or decide on a posting date), or
  NetSuite being unavailable.
- After fixing the cause, `POST /dead-letters/{id}/replay`. Posting is idempotent (`externalId` =
  instruction id).

## Approval refused with BILL_NOT_ELIGIBLE

- A bill changed after the batch was created: it went on hold, was partly paid, or was deleted.
- Reject the batch with a reason, then create a new one.

## BATCH_MODIFIED_AFTER_APPROVAL

- **This is a security incident.** Data changed between approval and submission.
- Do not submit. Preserve the evidence (DB rows and audit events). Escalate to security and the
  controller.
