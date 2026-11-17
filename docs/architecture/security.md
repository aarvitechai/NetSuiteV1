# Security design, threat model and access control (Phase 11)

> This project teaches **security-aware design**. It is **not** PCI DSS compliant and makes no
> compliance claim. Compliance needs a formal assessment by a qualified assessor (QSA).

## Threat model (STRIDE)

| # | Threat (STRIDE) | Example against this system | Controls in this repo | Residual risk and next step |
|---|---|---|---|---|
| T1 | **S**poofing: forged webhook | An attacker POSTs a fake `payment.succeeded` to mark an invoice paid | HMAC-SHA256 signature on the raw body, a 5-minute timestamp window, constant-time compare, nothing stored before verification | If the secret leaks, rotate it (the previous secret stays valid temporarily) |
| T2 | **S**poofing: stolen API token | Someone calls the API with a leaked token | Bearer tokens compared as SHA-256 digests in constant time, role checks per route, rate limiting | Static tokens are for learning only. Production would use OAuth 2.0 / OIDC with short-lived tokens and MFA for people. |
| T3 | **T**ampering: changing an approved batch | Change the amount or payee after the checker approves | A content hash is frozen at approval and verified before submit (`BATCH_MODIFIED_AFTER_APPROVAL`). Every action is audited. | Database access must also be restricted, through IAM and separate DB users |
| T4 | **T**ampering: changing a bank file in transit or at rest | Edit a NACHA file in the SFTP outbound folder | SHA-256 recorded at creation and checked before (re)transmission; NACHA control totals; archive copy | Real SFTP: key auth, host-key pinning, and PGP-encrypted files where the bank supports them |
| T5 | **R**epudiation: "I never approved that" | A checker denies an approval | Append-only audit events (a DB trigger blocks UPDATE and DELETE) with actor, time and correlation ID | Ship audit events to WORM storage (for example S3 Object Lock) |
| T6 | **I**nformation disclosure: one customer sees another's invoices | Change an ID in the URL | Portal routes use only the token's subject. Foreign invoices return 404 (they do not reveal existence). Tests prove this. | — |
| T7 | **I**nformation disclosure: secrets or card data in logs | A stack trace logs the `Authorization` header | pino redaction paths (tested); no request bodies logged; SuiteScript `redact()`; 500 responses hide internals | Review new log statements in code review (checklist) |
| T8 | **I**nformation disclosure: bank account numbers | A DB dump exposes vendor accounts | Only vault tokens are stored. Account numbers exist only in memory while the file is built, and inside the file. | Encrypt the archive at rest (KMS) and restrict who can read it |
| T9 | **D**enial of service | Flood the API or webhooks | Per-IP rate limit (429 with Retry-After), 256 KB JSON limit, 64 KB webhook limit, and fast webhook acknowledgement with asynchronous processing | Add a WAF and API gateway limits in the cloud. Use a shared limiter for multiple instances. |
| T10 | **D**enial of service: XML bombs | A camt.053 file with entity expansion | DOCTYPE and ENTITY declarations are rejected before parsing | — |
| T11 | **E**levation of privilege: maker approves own batch | A user holds both the maker and checker roles | Maker ≠ checker is compared by **subject** (person), not by token or role | Enforce in the identity provider too (exclusive role groups) |
| T12 | **E**levation of privilege: over-permissive RESTlet | A generic "run any query" RESTlet | Allow-listed types, fields and statuses; restricted deployment audience | — |
| T13 | Injection: SQL | User input inside SuiteQL or PostgreSQL | `bindSuiteQL` (typed and escaped); `pg` parameters `$1`; table and field names only from code constants | — |
| T14 | Injection: path traversal | `../../etc/passwd` as a bank file name | `assertSafeName` on every file operation and route (returns 400) | — |
| T15 | XSS | An invoice memo with `<script>` in the portal | `textContent` rendering, a strict CSP, `nosniff` | — |

## Access-control matrix (API roles)

| Capability | ap_maker | ap_checker | ar_clerk | finance | ops | customer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View vendors and open bills | ✅ | ✅ | | | ✅ | |
| Payment proposal | ✅ | ✅ | | | | |
| Create payment batch | ✅ | | | | | |
| Approve or reject batch (not own) | | ✅ | | | | |
| Submit approved batch | | ✅ | | | ✅ | |
| Customers and open invoices (internal view) | | | ✅ | | ✅ | |
| Payment intent: create | | | ✅ (any customer) | | | ✅ (own only) |
| Capture, void, refund | | | ✅ | | | |
| Collections run, disputes | | | ✅ | | ✅ (run only) | |
| Reconciliation: view and import | | | | ✅ | ✅ | |
| Reconciliation: approve, reject, manual match | | | | ✅ | | |
| DLQ replay or discard, master-data sync | | | | | ✅ | |
| Bank inbound poll, quarantine replay | | | | | ✅ | |
| Audit trail | | ✅ | | | ✅ | |
| `/metrics`, ops dashboard | | | | | ✅ | |
| Portal (`/portal/*`) | | | | | | ✅ (own data) |

**Segregation of duties:**

- The person who **creates** a payment batch cannot **approve** it.
- The people who **pay** (AP) are not the people who **confirm** with the bank (finance
  reconciliation).

## Payment card data (PCI DSS scope considerations)

- Card numbers and CVV **never** reach Northstar. They are entered on the provider's hosted page.
- The API schema is `.strict()`, so `cardNumber` or `cvv` fields are rejected with 400. This is
  tested.
- We store only provider references (`cs_…`, `re_…`).
- With hosted checkout, a merchant typically falls into the smallest PCI DSS self-assessment
  category. **That still needs a formal assessment.** The webpage that redirects to checkout is still
  in scope (script integrity).
- Logs redact `cardNumber`, `cvv` and similar fields as a defence in depth.

## Secrets

| Secret | Where it lives (dev) | Where it lives (cloud) | Rotation |
|---|---|---|---|
| NetSuite TBA consumer and token secrets | `.env` (never committed) | AWS Secrets Manager or Azure Key Vault | Revoke and issue a new token in NetSuite, update the store; `CachedSecretProvider` picks it up |
| Webhook signing secret | `.env` | Secret manager | Set the new value as `WEBHOOK_SIGNING_SECRET` and keep the old one as `WEBHOOK_SIGNING_SECRET_PREVIOUS` until the provider has switched over |
| Database password | docker-compose (local only) | Managed DB with IAM auth or a rotated secret | Managed rotation |
| API tokens | `.env` | Replaced by an identity provider | — |

Build logs: CI never prints environment variables. Secrets are injected as masked CI secrets, and
`.env*` is git-ignored (except `.env.example`).

## Transport and data protection

- TLS everywhere, terminated at the load balancer. HSTS is enabled in production.
- Encryption at rest: managed DB storage encryption, plus a KMS-encrypted archive bucket for bank
  files.
- Data minimisation: no full bank accounts, no card data, and email addresses only where collections
  need them.
