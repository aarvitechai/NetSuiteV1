# Northstar Distribution — AP/AR & Banking Payments Integration Platform

This is a **learning project**: an end-to-end NetSuite integration platform for a fictional company,
Northstar Distribution. It covers:

- AP bill approval and vendor payment batches, including NACHA files
- AR customer payments and collections
- bank statement reconciliation
- a customer self-service portal

The scope is defined in [`plan.md`](plan.md). See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) for
what is real and what is simulated.

> All data is synthetic. Nothing here moves real money or talks to a real bank.

## Quick start

```bash
npm install
cp .env.example .env
npm test
```

## Commands

| Command                              | What it does                      |
| ------------------------------------ | --------------------------------- |
| `npm test`                           | Runs all automated tests (Vitest) |
| `npm run lint` / `npm run typecheck` | Static checks                     |
| `npm run ci`                         | The full quality gate used by CI  |

## Branches

`dev → staging → production → main`. See [CONTRIBUTING.md](CONTRIBUTING.md).
