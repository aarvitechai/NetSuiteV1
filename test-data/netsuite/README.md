# Synthetic NetSuite seed data

These are fictional records, loaded by `MockNetSuiteAdapter` and used in tests and the demo.

- Every bank detail is a **token** (`tok_…`). There are no real account numbers.
- Each bill or invoice exists to exercise one rule, noted in its `_note` field.
  (Fields that start with `_` are ignored by the loader.)
- The reference "today" for this data is **2026-11-20**.
