# Interview preparation: stories from this project

Each story uses the STAR format: **S**ituation, **T**ask, **A**ction, **R**esult. Each one is backed
by evidence you can point to.

## 1. Preventing double payments (AP, idempotency)

- **Situation.** Vendor payments can be retried by users, networks and workers. Paying twice is a
  real financial loss.
- **Task.** Make "pay this bill" safe under every kind of retry.
- **Action.**
  - Seven layered defences: the NetSuite *in-progress* flag, an open-batch check, duplicate invoice
    detection, a re-check at approval, a content hash, `Idempotency-Key`, and the NetSuite `externalId`
    set to the instruction ID.
- **Result.** Tests replay keys, resend bank files and redeliver webhooks. In every case exactly one
  Vendor Payment exists. Evidence: `tests/api/ap-payments.test.ts`, `docs/architecture/ap-payments.md`.

## 2. The dual-write problem (transactional outbox)

- **Situation.** "Save Settled", then "call NetSuite". A crash between the two leaves a payment
  settled but never posted.
- **Action.** I introduced a transactional outbox: the follow-up message is saved in the same DB
  transaction, and delivered at least once to idempotent handlers. Messages from a crashed process are
  recovered at start-up.
- **Result.** The test simulates a crash right after commit. After restart, both Vendor Payments post
  exactly once. Evidence: `tests/reliability/outbox.test.ts`.

## 3. A load test found a 64× bottleneck (performance)

- **Situation.** Every functional test was green.
- **Action.** I ran the plan's high-volume load test. AR payments managed only 10/s. I profiled it and
  found that each transaction deep-copied the whole in-memory store, and replaced that with an undo log.
- **Result.** 644/s, and webhook p50 dropped from 97 ms to 0.9 ms. I also found that the REST adapter
  flags bills one request at a time, and documented a bulk-RESTlet remedy. Evidence:
  `docs/performance/report.md`.

## 4. Settled but missing from the bank (reconciliation)

- **Question.** "How would you investigate a payment marked settled but missing from the bank?"
- **Answer.** Use the trace number and bank reference, then the statement dates (D+0 to D+2). Check
  whether the bank aggregated the batch (one-to-many), and whether there was a return. Then go back
  through the ACK, STATUS and outbound file checksums, and escalate to the bank with the trace number.
  Meanwhile control check AP-3 shows the gap, so the period cannot be closed by accident. Evidence:
  `docs/runbooks/integration-incidents.md` §6.

## 5. Choosing an API: RESTlet or SuiteTalk REST

- Use **SuiteTalk REST** for standard CRUD and SuiteQL.
- Use a **RESTlet** only when logic inside NetSuite or a narrower permission scope is needed.
- My RESTlet updates exactly four integration fields. It uses allow-lists and a restricted audience,
  and never offers a generic query passthrough. Evidence: `nsd_rl_integration_status.js`,
  `docs/architecture/netsuite-integration.md`.

## 6. Bugs caught by my own tests (quality)

The defect log has 14 entries. Examples:

- the bearer token was only partly redacted;
- a top-level secret was not redacted from logs;
- the Windows lockfile broke Linux `npm ci`;
- the container could not write as a non-root user.

Each was caught by a test, a CI run or a smoke test before release. Evidence:
`docs/testing/defect-log.md`.

## 7. Explaining it to a finance stakeholder

"When a vendor bill is approved, NetSuite records what we owe. We only record that it is *paid* when
the bank confirms the money left. If the bank returns it, we undo that automatically. Every day we
compare four lists:

- what we intended to pay;
- what NetSuite says we paid;
- what the bank shows;
- what the payment provider reports.

If any number differs by a cent, we know before month-end."

## 8. What I would change before scaling to multiple subsidiaries or ERPs

- Add a `subsidiary` to every entity and batch, with one bank account and one file per subsidiary, and
  NetSuite postings with subsidiary and FX handling.
- Put a canonical domain model behind the `NetSuitePort`, so a second ERP is just another adapter.
- Use PostgreSQL `FOR UPDATE SKIP LOCKED`, or SQS, for multi-worker outbox delivery.
- Move the bulk bill flagging to a RESTlet or Map/Reduce (open defect D-012).
- Use OIDC instead of static tokens, with per-subsidiary roles.

## Glossary to know cold

Records, transaction types, script types and governance, SuiteTalk, SDF, SuiteFlow, SuiteQL, SCMA,
NACHA records, ACH return codes, camt.053, idempotency, outbox and inbox, DLQ, maker-checker. See
`docs/business-processes/glossary.md`.

## Certification (in parallel)

- SuiteFoundation, then SuiteCloud Developer.
- Check Oracle's current exam objectives and eligibility before booking.
