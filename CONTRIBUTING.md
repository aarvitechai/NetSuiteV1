# Contributing and working conventions

## Branches

| Branch       | Purpose                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `dev`        | Day-to-day integration branch. All new work lands here first.                   |
| `staging`    | UAT and sandbox testing. Fast-forwarded from `dev` once CI passes.              |
| `production` | Code approved for production. Fast-forwarded from `staging` after UAT sign-off. |
| `main`       | Mirror of the latest released state. Fast-forwarded from `production`.          |

Changes are promoted in one direction only: `dev → staging → production → main`.
Never commit directly to `staging`, `production` or `main`.

## Commit messages

- Write the subject line in the imperative, for example `Add NACHA file generator`.
- Use the body to explain _why_ the change was made.
- Reference the phase where it helps, for example `Phase 7`.

## Coding conventions

- TypeScript `strict` mode is on. Avoid `any`.
- **Money** is stored as `Decimal` (decimal.js) or as strings. Never as a JS `number`.
- **Dates** are ISO 8601 strings, and currency codes follow ISO 4217 (for example `USD`).
- Every inbound payload is validated with Zod at the API boundary.
- Comments explain **why** the code does something, not just what it does. This is a learning
  repository.
- Provider-specific data shapes stay inside `middleware/src/adapters/*`.

## Quality gate (also run in CI)

```bash
npm run ci   # lint + format check + typecheck + tests
```
