# Learning log

One entry per phase: what was built, the key concepts, and answers to the plan's review questions.

## Phase 0 — Environment, access and project setup

**Built:**

- Repository scaffold: TypeScript, ESLint, Prettier and Vitest.
- `.env.example`.
- Validated configuration in `middleware/src/shared/config.ts`.
- Access checklist.
- ADR-0001.
- Branch policy (`dev → staging → production → main`).

**Key concepts**

- **Production, sandbox and local simulation.**
  - _Production_ is the live company account, holding real money and real data.
  - A _sandbox_ is a copy of the account for testing. It is still NetSuite, but transactions
    there have no real-world effect.
  - _Local simulation_ (this repo's mocks) involves no NetSuite at all. It runs fast and for
    free, but it only _imitates_ NetSuite's behaviour.
- **Why validate config at start-up?** A bad configuration should crash the app immediately, with a
  clear message. It is far worse to discover it halfway through a payment batch.

**Review questions**

1. _Why does NetSuite remain the accounting system of record?_
   Finance closes the books in NetSuite, auditors look at NetSuite, and the GL lives there. A second
   copy of balances in the middleware would drift and create reconciliation work.
2. _What is the difference between production, sandbox and local simulation?_
   See the key concepts above.
3. _Which features require licensing or administrator enablement?_
   SuiteCommerce MyAccount, payment SuiteApps and bank feeds need licences. REST and SOAP web
   services, Token-Based Authentication, SuiteScript, SuiteFlow and SDF need an administrator to
   enable them under _Setup → Company → Enable Features_. See `docs/access-checklist.md`.
