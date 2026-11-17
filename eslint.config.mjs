// ESLint finds likely bugs and bad patterns. Prettier (separate tool) handles formatting only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'runtime-data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Unused variables are usually leftovers or bugs. Prefix with _ to mark "intentionally unused".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // console.log bypasses our structured logger (and its secret redaction). Use the logger.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Scripts and simulators are command-line tools, so printing to the console is their job.
    files: ['scripts/**/*.ts', 'simulators/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // SuiteScript files are AMD modules executed inside NetSuite, not Node.js.
    files: ['netsuite/src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { define: 'readonly', log: 'readonly' },
    },
  },
  {
    files: ['portal/local-prototype/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
);
