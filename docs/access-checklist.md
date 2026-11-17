# Access checklist (Phase 0)

Use this table to record what you can really access. Anything marked **No** is covered by the local
mock alternative in the last column, and that mock is clearly labelled in the code.

| #   | Capability                                                     | Needed for        | Available? | Local alternative in this repo                                                                |
| --- | -------------------------------------------------------------- | ----------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1   | NetSuite sandbox / developer account                           | Phases 2–4, 6, 13 | ☐ Yes ☐ No | `MockNetSuiteAdapter` (in-memory records, external IDs, simulated 429/5xx)                    |
| 2   | Administrator role (to enable features)                        | Phase 2           | ☐ Yes ☐ No | Feature list documented in `docs/netsuite/data-dictionary.md`                                 |
| 3   | SuiteCloud Development Framework (SDF) + SuiteCloud CLI        | Phases 3, 13      | ☐ Yes ☐ No | SDF project in `netsuite/`; scripts are unit-tested with the AMD harness in `netsuite/tests/` |
| 4   | SuiteScript 2.x (server and client scripts)                    | Phase 3           | ☐ Yes ☐ No | Same harness, with stubbed `N/*` modules                                                      |
| 5   | SuiteTalk REST Web Services (feature: _REST Web Services_)     | Phases 5–6        | ☐ Yes ☐ No | `MockNetSuiteAdapter`; `NetSuiteRestAdapter` is ready for a real account                      |
| 6   | SuiteTalk SOAP Web Services                                    | Phase 6           | ☐ Yes ☐ No | SOAP envelope builder plus design notes only (`NetSuiteSoapAdapter`)                          |
| 7   | Token-Based Authentication (integration record + access token) | Phase 6           | ☐ Yes ☐ No | OAuth 1.0a signer is unit-tested against a fixed vector                                       |
| 8   | SuiteFlow (workflows)                                          | Phase 4           | ☐ Yes ☐ No | Workflow specs in `docs/netsuite/workflows.md`                                                |
| 9   | SuiteQL / saved searches                                       | Phase 4           | ☐ Yes ☐ No | Query library in `netsuite/suiteql/`                                                          |
| 10  | SuiteCommerce MyAccount (SCMA)                                 | Phase 9           | ☐ Yes ☐ No | `portal/local-prototype/`, labelled **local prototype — not an SCMA extension**               |
| 11  | Payment SuiteApps / bank feeds                                 | Phases 7, 10      | ☐ Yes ☐ No | `simulators/payment-provider`, `simulators/bank`                                              |
| 12  | Bank SFTP sandbox                                              | Phases 7, 10      | ☐ Yes ☐ No | Local folder `runtime-data/sftp` (`LocalFolderSftp`)                                          |
| 13  | AWS or Azure learning account                                  | Phases 11, 13     | ☐ Yes ☐ No | Docker Compose locally; deployment documented in `docs/architecture/deployment.md`            |
| 14  | PostgreSQL                                                     | Phase 5           | ☐ Yes ☐ No | `docker compose up db`, or `STORAGE_MODE=memory`                                              |

**Rules that apply whatever you have access to:**

- Use synthetic data only.
- Never use real bank credentials, card numbers or CVV.
- Never point this project at a production NetSuite account.
