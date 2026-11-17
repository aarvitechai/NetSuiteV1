# Performance report (Phase 11)

**Command:** `npm run loadtest -- --vendors 500 --billsPerVendor 10 --payments 300`

**Environment:** Node 24, a Windows laptop, in-memory store, and **mock NetSuite**. The timings
measure **middleware overhead only**. Real NetSuite latency (typically 200–1500 ms per REST call) and
concurrency limits dominate in production. That is why the *NetSuite calls* column matters most.

The raw output of the last run is in `last-run.json`.

## Results (after the fix described below)

| Stage | Items | Time | Throughput | NetSuite API calls |
|---|---|---|---|---|
| AP proposal (eligibility rules over 5,000 bills) | 5,000 | 92 ms | 54,000/s | 2 |
| AP create batch | 5,000 | 84 ms | 59,000/s | 2 |
| AP approve (re-check plus content hash) | 5,000 | 126 ms | 39,700/s | 2 |
| AP submit (flag bills, NACHA for 500 vendors, SFTP) | 500 | 160 ms | 3,100/s | 2 *(see finding 2)* |
| Bank ACK processing | 500 | 55 ms | 9,000/s | 0 |
| Settlement → 500 NetSuite Vendor Payments (outbox) | 500 | 262 ms | 1,900/s | 500 |
| AR payments (intent, checkout, signed webhook, inbox, outbox, Customer Payment) | 300 | 466 ms | 644/s | 600 |
| Reconciliation (501 statement lines) | 501 | 813 ms | 617/s | 502 |

- **Webhook end-to-end latency:** p50 0.9 ms, p95 1.6 ms, p99 2.1 ms.
- **Outbox after the run:** 0 pending. **DLQ:** 0. **Heap:** about 61 MB.

## Finding 1: O(N) transaction snapshot in the memory store (fixed)

The first run showed **AR payments at only 10/s**, with webhook p50 at 96.6 ms.

**Cause:** `MemoryStore.transaction()` deep-copied the *whole* store (`structuredClone`) at the start
of every transaction, so that it could roll back. Each payment runs several transactions, and the
store kept growing (audit events, jobs, outbox messages). The cost per payment therefore grew with
total data volume.

**Fix:** an **undo log**. Each write inside a transaction records the previous value of only the key
it touches. Rollback replays those records in reverse.

**Result:** AR throughput went from **10/s to 644/s** (64× faster), and webhook p50 went from
**96.6 ms to 0.9 ms**. The Store contract tests (rollback, nested transactions) still pass.

*Lesson:* this is why the plan asks for a load test. The functional tests were green, but the design
did not scale.

## Finding 2: bill flagging is one request per bill in the REST adapter (open)

`NetSuiteRestAdapter.setBillPaymentFlags` sends **one PATCH per bill**. For a 5,000-bill run that is
5,000 sequential REST calls. At about 300 ms each, that is roughly 25 minutes, and it burns concurrency
the whole time.

**Recommended options:**

1. A RESTlet `nsd_rl_bill_flags` that accepts up to N bill IDs and uses `record.submitFields` (about
   2 governance units each). That gives one request per 500 bills.
2. Or start a Map/Reduce (via `N/task`) that flags every bill with a given batch reference. This is
   asynchronous and restart-safe.
3. Run the calls in parallel, with bounded concurrency, up to the account's concurrency limit.

## Governance and API usage per business volume

These are derived from the call counts above.

| Business event | NetSuite REST requests (approximate) |
|---|---|
| Payment proposal or approval | 2 SuiteQL queries (paged: +1 per 1,000 rows) |
| Submitting a batch of B bills | B PATCH calls today. With option 1 above, about B ÷ 500. |
| Each settled vendor payment | 1 lookup + 1 create, plus ID lookups for the vendor and bills (cached after first use) |
| Each online customer payment | 1 SuiteQL (open invoices) + 1 create |
| Reconciliation of L lines | 1 SuiteQL + 1 custom-record create per approved match |

The NetSuite-side scripts are governed separately (see `docs/netsuite/suitescript-guide.md`). The
collections Map/Reduce spends about 10 units per changed invoice, in its own reduce invocation.

## How to measure against a real sandbox

1. Set `NETSUITE_MODE=rest` with sandbox credentials. **Use small volumes first.**
2. Watch *Setup → Integration → Integration Governance* (concurrency) and the script execution logs.
3. Record p95 latency per NetSuite call, and the number of 429 responses. If 429s appear, lower the
   concurrency (`MasterDataSyncService` concurrency, outbox worker parallelism).
