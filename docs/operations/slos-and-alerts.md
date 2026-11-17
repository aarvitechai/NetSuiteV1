# SLIs, SLOs, dashboards and alerts (Phase 14)

## Service level indicators and objectives

| SLI (what we measure) | Source | SLO (target, 30 days) | Why it matters |
|---|---|---|---|
| API availability: share of non-5xx responses | `http_requests_total{status!~"5.."}` / total | **99.5%** | AP, AR and the portal depend on it |
| API latency: p95 of `/api/v1/*` | `http_request_duration_ms` | **< 500 ms**, excluding NetSuite-bound reads | User experience |
| Webhook acknowledgement: share answered 2xx within 2 s | Logs and metrics on `/webhooks/payment-provider` | **99.9%** | Slow acknowledgement causes provider retries and duplicates |
| Payment posting freshness: time from settlement event to NetSuite payment | Outbox age plus job duration | **95% < 5 min** | Finance sees correct balances the same day |
| Payment correctness: control-totals checks balanced per day | `/reconciliation/control-totals` | **100%** (any imbalance is an incident) | Money |
| Reconciliation backlog: exceptions older than 3 business days | `nsd_recon_exceptions_open` and age | **0 at month-end** | Period close |
| DLQ hygiene: open dead letters older than 24 h | `nsd_dead_letters_open` | **0** | Nothing silently stuck |

## Dashboard panels

Use Grafana or CloudWatch, fed by `GET /metrics`.

| Row | Panels |
|---|---|
| Traffic | Requests per second by route, 5xx rate, p50/p95/p99 latency |
| Integration health | Outbox pending and oldest age, DLQ open, failed webhooks, quarantined bank files |
| Business flow | Payment batches by status, reconciliation exceptions and suggestions awaiting approval, settlement mismatches |
| Dependencies | `/ready` status per dependency, NetSuite 429s and 5xx (log-based) |

For a quick text view, `GET /api/v1/ops/dashboard` returns the same health numbers as JSON.

## Alerts

The rules are in [`infrastructure/monitoring/prometheus-alerts.yml`](../../infrastructure/monitoring/prometheus-alerts.yml).

| Alert | Condition | Severity | Runbook |
|---|---|---|---|
| `ApiHighErrorRate` | 5xx above 2% for 10 min | SEV2 | integration-incidents §1 |
| `OutboxBacklog` | Oldest pending above 300 s for 5 min | SEV2 | §7 |
| `DeadLettersOpen` | DLQ open above 0 for 30 min | SEV3 (SEV2 above 20) | §1 |
| `WebhooksFailing` | `nsd_webhooks_failed` increasing | SEV2 | §3 |
| `BankFileQuarantined` | Quarantined above 0 | SEV3 | §4 |
| `SettlementMismatch` | Mismatched above 0 | SEV2 | §5 |
| `ReconExceptionsAging` | Exceptions above 0 for 3 days | SEV3 | §5 |
| `ControlTotalsImbalance` | Daily job reports `balanced=false` | **SEV1** | §6 |

**Alert design rules:**

- Every alert links to a runbook section.
- Every alert is actionable. If nobody needs to act, it is not an alert.
- Severity decides who is woken up (see the escalation table in the runbook).
