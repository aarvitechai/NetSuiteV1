# Exception catalogue

Each exception has a code. That code appears in error responses, logs and the exception queue, so
support staff can look it up here.

| Code                        | Situation                                                            | Type            | Automatic handling                                    | Human action                                 |
| --------------------------- | -------------------------------------------------------------------- | --------------- | ----------------------------------------------------- | -------------------------------------------- |
| `VALIDATION_FAILED`         | Request payload is invalid                                           | Permanent (400) | Rejected, not retried                                 | Fix the caller                               |
| `DUPLICATE_BILL`            | The same vendor and invoice number already exists or is already paid | Permanent       | Excluded from the proposal                            | AP reviews the vendor's statement            |
| `BILL_NOT_ELIGIBLE`         | Bill is on hold, unapproved, not due, or the vendor is inactive      | Permanent       | Excluded, with the reason recorded                    | —                                            |
| `MAKER_CHECKER_VIOLATION`   | The same user tried to both create and approve a batch               | Permanent (403) | Rejected                                              | Approve as a different user                  |
| `ILLEGAL_STATE_TRANSITION`  | A status change is not allowed                                       | Permanent (409) | Rejected                                              | Investigate the cause                        |
| `IDEMPOTENCY_CONFLICT`      | The same idempotency key was reused with a different payload         | Permanent (409) | Rejected                                              | Use a new key                                |
| `NETSUITE_RATE_LIMITED`     | NetSuite returned 429 or concurrency is exceeded                     | Transient       | Retried with backoff and jitter                       | —                                            |
| `NETSUITE_UNAVAILABLE`      | 5xx error or timeout                                                 | Transient       | Retried, then sent to the DLQ                         | Replay after the outage                      |
| `NETSUITE_BUSINESS_ERROR`   | NetSuite rejected the record (for example a closed period)           | Permanent       | Sent to the DLQ                                       | Finance fixes the data, then ops replays     |
| `WEBHOOK_SIGNATURE_INVALID` | Webhook signature is bad or too old                                  | Security (401)  | Rejected and logged                                   | Investigate if it repeats                    |
| `WEBHOOK_DUPLICATE`         | The same provider event ID was received again                        | Expected        | Acknowledged (200) with no effect                     | —                                            |
| `BANK_FILE_REJECTED`        | The bank rejected a payment file                                     | Permanent       | The batch is set to Failed and the bills are released | AP corrects the data and re-proposes         |
| `PAYMENT_RETURNED`          | ACH return (R01, R03…)                                               | Business        | Payment → Returned, and an exception is raised        | Contact the vendor, then reverse the payment |
| `DUPLICATE_FILE`            | A bank file with the same checksum was already processed             | Expected        | Skipped and archived                                  | —                                            |
| `FILE_PARSE_ERROR`          | A bank file cannot be parsed                                         | Permanent       | Quarantined                                           | Ask the bank to resend                       |
| `RECON_UNMATCHED`           | No safe match was found for a bank line                              | Business        | Sent to the exception queue                           | Match it manually or investigate             |
| `RECON_AMOUNT_MISMATCH`     | The reference matches but the amount differs                         | Business        | Sent to the exception queue                           | Usually a fee or partial payment             |
