// Copies the non-TypeScript files the server needs at runtime into dist/, at the same relative
// positions the code expects (each module finds them via __dirname).
// WHY: `tsc` only emits .js files. SQL migrations, the OpenAPI document, SuiteQL queries, the portal
// and the mock seed data would otherwise be missing from the build and the Docker image.
import { cpSync, existsSync } from 'node:fs';

const copies = [
  ['middleware/openapi.yaml', 'dist/middleware/openapi.yaml'],
  ['middleware/src/infrastructure/db/migrations', 'dist/middleware/src/infrastructure/db/migrations'],
  ['netsuite/suiteql', 'dist/netsuite/suiteql'],
  ['portal/local-prototype', 'dist/portal/local-prototype'],
  ['test-data/netsuite', 'dist/test-data/netsuite'], // used only when NETSUITE_MODE=mock
];

for (const [from, to] of copies) {
  if (!existsSync(from)) throw new Error(`Missing asset ${from}`);
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
