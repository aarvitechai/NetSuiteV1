# Runbook: integration incidents

**First step for every incident:**

1. Open `GET /api/v1/ops/dashboard`.
2. Note the alert's correlation ID.
3. Look up the audit trail with `GET /api/v1/audit?correlationId=…`.

Failed AP batches are covered in [ap-payments.md](ap-payments.md). Deployments are covered in
[deployment-rollback.md](deployment-rollback.md).

---

## 1. NetSuite outage (5xx, timeouts)

**Symptoms:**

- `/ready` shows `netsuite: error`.
- Alert `NetSuiteUnavailable`.
- DLQ entries with `NETSUITE_UNAVAILABLE`.
- Outbox age rising.

**What the system already does:**

- It retries 4× with backoff and jitter.
- It then moves work to the DLQ.
- The outbox keeps every follow-up action.
- The load balancer stops routing to instances that are not ready, but they are **not** restarted.

**Actions:**

1. Check the [NetSuite status page](https://status.netsuite.com) and your account's maintenance
   window.
2. **Do not** replay dead letters while NetSuite is down. Each replay just fails again.
3. When `/ready` is green again, replay **in business order**: master data first, then payments, then
   deposits, then reconciliation records.
   - `GET /api/v1/dead-letters`, then `POST /dead-letters/{id}/replay` for each one.
   - Replays are idempotent (externalIds), so a payment cannot be posted twice.
4. Run `POST /api/v1/reconciliation/rematch` for statement lines that arrived during the outage.
5. Confirm with `GET /reconciliation/control-totals` for today. Every check should be `ok`.

## 2. Expired or revoked NetSuite token (401 / 403)

**Symptoms:**

- Errors with `NETSUITE_AUTH_FAILED`.
- These are **not** retried, because they are permanent until fixed.

**Actions:**

1. In NetSuite, go to *Setup → Users/Roles → Access Tokens*. Check that the token for the
   integration role is active, and that the role still has its permissions. Role edits often break
   integrations.
2. If the token was revoked or rotated, create a new access token and update the secret manager entry
   `northstar/<env>/netsuite`. Running instances pick it up after the secret cache TTL. A restart is
   also fine.
3. Replay the dead letters (see section 1, step 3).
4. With OAuth 2.0 instead of TBA, the refresh happens automatically. A 401 then usually means the
   certificate expired or the client was disabled.

## 3. Duplicate webhooks

**Symptoms:**

- Logs show `duplicate webhook delivery ignored`.
- Provider dashboard shows many retries.

**This is expected behaviour.** Duplicates are acknowledged with 200, and nothing happens.

**Investigate only if** the provider keeps retrying the *same* event. That means it never saw our 2xx
response. Check:

- Our `/webhooks/payment-provider` latency.
- The WAF or load balancer timeouts.
- `WEBHOOK_SIGNATURE_INVALID` audit events. A rotated secret that is not yet configured on our side
  produces 401s, which the provider retries.

**If signatures fail after a secret rotation:**

1. Set the new secret as `WEBHOOK_SIGNING_SECRET`.
2. Keep the old one as `WEBHOOK_SIGNING_SECRET_PREVIOUS` until the provider has fully switched over.
3. Then remove the old one.

## 4. Bank file failures

| Symptom | Meaning | Action |
|---|---|---|
| File in `quarantine/` (alert `BankFileQuarantined`) | We could not parse it, the balances did not add up, or it is an unknown type | Read the `bank_files` error. Ask the bank to resend, or fix our parser. Put the corrected file in place, then `POST /bank/files/quarantine/{name}/replay` |
| `DUPLICATE` result | Same checksum received before | Nothing to do. This is normal when the bank resends. |
| ACK `REJECTED` for a whole file | The bank refused our payment file | See ap-payments.md ("File rejected"). The bills are released automatically. |
| No ACK within 2 business hours of submission | The file did not reach the bank, or the bank is late | Check `file.transmitted`, the SFTP connectivity, and call the bank. **Never** create a second batch for the same bills. |

## 5. Reconciliation exceptions

**Queue:** `GET /api/v1/reconciliation/matches?status=EXCEPTION`

| Code | Typical cause | Resolution |
|---|---|---|
| `RECON_UNMATCHED` | Bank fee, interest, an unexpected transfer, or a payment posted late in NetSuite | Late posting: replay the DLQ, then `rematch`. Fee or interest: finance books a journal entry, then does a manual match. Unknown: investigate before month-end. |
| `RECON_AMOUNT_MISMATCH` | Fee deducted from the payout, partial payment, or a wrong amount | Compare with the provider's settlement report. Book the difference, then match manually. |
| `RECON_AMBIGUOUS` | Two transactions with the same amount and date | Finance picks the right one through manual match |
| `RECON_REJECTED` | A human rejected the suggestion | Manual match, with a reason |

Every decision is audited. Month-end target: zero exceptions older than 3 business days.

## 6. "Payment marked settled but missing from the bank"

This is a classic senior-level investigation.

1. Find the instruction (`GET /payment-batches/{id}`). Note its `traceNumber`, `bankRef` and
   `settledOn`.
2. Look for the bank line with that reference: `GET /reconciliation/lines?status=EXCEPTION`, or the
   statement for `settledOn` and the next 2 business days. Banks can book a day later.
3. Is the bank debit **aggregated** (one line for the whole batch)? Then look for `GROUP_REF` matches,
   or a line that equals the batch total.
4. Was it **returned**? Look for a `RETURN_*` status file and the instruction status `Returned` or
   `Reversed`.
5. Still missing? Check the outbound file record (`bank_files`, checksum), the ACK, and the STATUS
   file that claimed settlement. Escalate to the bank with the trace number and the file name.
6. Until it is resolved, the control-totals check **AP-3** will show the difference. Do not close the
   period.

## 7. Outbox growing or not draining

**Alert:** `OutboxBacklog` fires when the oldest pending message is more than 5 minutes old.

**Actions:**

- Check that the workers are running (`DISPATCH_MODE=worker`, enough ECS tasks).
- Check that the outbox is not stuck behind a NetSuite outage (section 1).
- After a crash, `recoverStuck()` runs at start-up, so restarting one worker is safe.

## Escalation

| Severity | Examples | Respond within | Who |
|---|---|---|---|
| SEV1 | Wrong or duplicate payments, payments not sent on payment day, data exposure | 15 minutes, 24/7 | On-call engineer, then integration lead, controller and security |
| SEV2 | NetSuite outage over 1 hour, webhooks failing, outbox over 30 minutes | 1 business hour | On-call engineer |
| SEV3 | Single DLQ items, reconciliation exceptions | Next business day | Ops / finance |
