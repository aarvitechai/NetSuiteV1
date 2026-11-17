# Incident postmortem: <title>

> **Blameless.** We look at how the *system* allowed the failure, not at who to blame. People act
> reasonably given the information and tools they had at the time.

| Field | Value |
|---|---|
| Incident ID / severity | INC-____ / SEV_ |
| Date and duration | start → detection → mitigation → resolution (UTC) |
| Authors | |
| Status | draft / reviewed / actions complete |

## Summary

Two or three sentences: what happened, and what the impact was in business terms. For example: "12
vendor payments were posted to NetSuite 3 hours late. No payment was duplicated or lost."

## Impact

- Money: amounts and counts affected. Any duplicate, missing or incorrect posting?
- Customers and vendors: who noticed, and what they experienced.
- Data: anything exposed? (If yes, follow the security incident procedure.)
- SLOs consumed: which ones, and how much error budget was used.

## Timeline (UTC)

| Time | Event | Source (alert, log, correlation ID) |
|---|---|---|
| | | |

## Root cause and contributing factors

Ask "why?" until you reach something structural: a process gap, a missing test, a missing alert.

## Detection

- How did we find out (an alert, a customer, finance)?
- How could we have found out sooner?

## What went well, and what went badly

## Proof that money is correct after recovery

- Control totals for the affected period: `balanced: true`? Attach the JSON.
- Reconciliation report: open exceptions?
- DLQ and outbox: empty?

## Action items

| # | Action | Type (prevent / detect / mitigate) | Owner | Due | Ticket |
|---|---|---|---|---|---|
| 1 | | | | | |
