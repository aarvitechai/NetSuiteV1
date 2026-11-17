// Vitest is our test runner. It understands TypeScript directly, so tests need no build step.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['middleware/tests/**/*.test.ts', 'netsuite/tests/**/*.test.ts', 'simulators/**/*.test.ts'],
    environment: 'node',
    // Tests must never depend on a real NetSuite, bank or database: everything runs in memory.
    coverage: {
      include: ['middleware/src/**/*.ts', 'netsuite/src/**/*.js'],
      reporter: ['text', 'html'],
    },
  },
});
