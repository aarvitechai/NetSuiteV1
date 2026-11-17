# SuiteQL query library

Each `.sql` file holds **one** read-only query. The header comment says who uses it and what it is
for. These files are run in two ways:

- **From the middleware**, through `POST /services/rest/query/v1/suiteql`, using
  `NetSuiteRestAdapter.suiteql()`. Paging uses the `limit` and `offset` URL parameters, with at most
  1,000 rows per page.
- **From SuiteScript**, through `N/query.runSuiteQLPaged({ query, params, pageSize })`.

## Parameters

Parameters use `:name` placeholders. The middleware binds them with `bindSuiteQL()`, which accepts only
numbers, ISO dates and escaped strings. Query text is **never** built by concatenating user input,
because that is how SQL injection happens.

## Rules

- Never use `SELECT *`. Select only the columns you need, which is faster and exposes less data.
- Always filter on an indexed field (`type`, `id`, or dates) before joining.
- Use `BUILTIN.DF(field)` to get the display text of a list or record field (for example the vendor
  name) without an extra join.
- Verify field availability in your account with the Records Catalog
  (*Setup → Records Catalog*). Fields can differ by edition and enabled features.
