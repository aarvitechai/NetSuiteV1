# Developer setup

## Prerequisites

- Node.js 22 or later (LTS recommended). CI tests Node 22 and 24.
- Git
- *Optional:* Docker, for PostgreSQL

## First run

```bash
npm install
cp .env.example .env          # synthetic, local-only values
npm test                      # all tests use in-memory fakes, so no Docker is needed
npm run dev                   # http://localhost:3000 with an in-memory store and mock NetSuite
```

Try it:

```bash
curl localhost:3000/ready
curl -H "Authorization: Bearer dev-maker-token" localhost:3000/api/v1/bills/open
```

## Using PostgreSQL

```bash
docker compose up -d db
# in .env: STORAGE_MODE=postgres
npm run db:migrate
npm run dev
```

To run the Store contract tests against PostgreSQL as well:

```bash
TEST_DATABASE_URL=postgres://northstar:northstar@localhost:5432/northstar npm test
```

> These contract tests **drop and recreate the `public` schema**. Point them only at a throwaway
> database.

## Using a real NetSuite sandbox

1. In NetSuite, enable *REST Web Services* and *Token-Based Authentication*.
2. Create an Integration record. It gives you a consumer key and secret.
3. Create a role with least privilege, then create an Access Token for that role. It gives you a
   token ID and secret.
4. Fill in the `NETSUITE_*` variables in `.env` and set `NETSUITE_MODE=rest`.
5. Deploy the SDF project in `netsuite/`. The custom fields must exist before the middleware writes
   them.

Never commit `.env`. `.gitignore` already excludes it.

## Project layout

| Folder | What lives there |
|---|---|
| `middleware/src/api` | HTTP layer: routes, auth, validation, error handling |
| `middleware/src/application` | Use cases (services) and ports (interfaces) |
| `middleware/src/domain` | Pure business rules: money, state machines, eligibility, matching |
| `middleware/src/adapters` | Translators to external systems: NetSuite, payment provider, bank |
| `middleware/src/infrastructure` | Storage, queues, files, secrets |
| `middleware/src/shared` | Config, logging, errors, context, utilities |
| `netsuite/` | SDF project: SuiteScripts, custom objects, SuiteQL |
| `simulators/` | Fake payment provider and bank |
| `portal/` | Customer portal prototype |
| `docs/` | Architecture, processes, runbooks, decisions |
