/**
 * Pure business rules shared by Northstar SuiteScripts.
 *
 * WHY "pure": these functions take plain values and return plain values. They never call NetSuite
 * APIs. That means:
 *   1. They can be unit-tested on a laptop (see netsuite/tests/rules.test.ts).
 *   2. The same rule gives the same answer in a User Event, a Map/Reduce or a RESTlet.
 *   3. The script files stay thin: "read from NetSuite → call rule → write to NetSuite".
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['./nsd_constants'], (C) => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  /** Whole days from `from` to `to` (negative if `to` is earlier). Uses UTC to ignore DST shifts. */
  function daysBetween(from, to) {
    const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / MS_PER_DAY);
  }

  /**
   * Validates the fields of a vendor bill before it is saved.
   * @param {{ tranId?: string, total?: number, tranDate?: Date, dueDate?: Date }} bill
   * @returns {string[]} human-readable problems; empty array = valid
   */
  function validateVendorBill(bill) {
    const errors = [];
    // The vendor's invoice number is what we use to detect duplicates, so it is mandatory.
    if (!bill.tranId || !String(bill.tranId).trim())
      errors.push('Vendor invoice number (Reference No.) is required.');
    if (typeof bill.total !== 'number' || !(bill.total > 0))
      errors.push('Bill total must be greater than zero.');
    if (bill.tranDate && bill.dueDate && bill.dueDate < bill.tranDate) {
      errors.push('Due date cannot be before the bill date.');
    }
    return errors;
  }

  /**
   * Fields that must not change once a bill is in a submitted payment batch.
   * WHY: the bank file already contains the amount. Editing it in NetSuite would make NetSuite and the
   * bank disagree, and reconciliation would fail.
   */
  const LOCKED_WHEN_IN_PROGRESS = ['entity', 'currency', 'usertotal', 'tranid'];

  /**
   * Returns the list of locked fields that changed between the old and new versions of a bill.
   * @param {Record<string, unknown>} oldValues
   * @param {Record<string, unknown>} newValues
   */
  function changedLockedFields(oldValues, newValues) {
    return LOCKED_WHEN_IN_PROGRESS.filter((f) => String(oldValues[f]) !== String(newValues[f]));
  }

  /**
   * Decides the collections stage of an overdue invoice.
   * WHY deterministic (based only on days overdue): if the Map/Reduce is restarted halfway, running it
   * again produces exactly the same result. That is what makes it "restart-safe".
   *
   * @param {number} daysOverdue  positive = past due
   * @param {boolean} disputed     disputed invoices get no reminders
   */
  function collectionStage(daysOverdue, disputed) {
    if (disputed || daysOverdue < 1) return C.COLLECTION_STAGE.NONE;
    if (daysOverdue < 30) return C.COLLECTION_STAGE.REMINDER_1;
    if (daysOverdue < 60) return C.COLLECTION_STAGE.REMINDER_2;
    return C.COLLECTION_STAGE.ESCALATED;
  }

  /**
   * Removes anything that looks like a secret or card number from text before we store or log it.
   * WHY: error messages from external systems sometimes echo request data. Logs are read by many
   * people and kept for years, so sensitive data must never reach them.
   */
  function redact(text) {
    return (
      String(text == null ? '' : text)
        .replace(/\b\d{13,19}\b/g, '[REDACTED-PAN]') // card-number-like digit runs
        // "(?:bearer|basic|oauth)\s+" also swallows the scheme word, so "Authorization: Bearer abc" loses "abc" too.
        .replace(
          /(authorization|token|secret|password)\s*[:=]\s*(?:(?:bearer|basic|oauth)\s+)?\S+/gi,
          '$1=[REDACTED]',
        )
        .slice(0, 3900)
    ); // fits a long text field with room to spare
  }

  return {
    daysBetween,
    validateVendorBill,
    changedLockedFields,
    LOCKED_WHEN_IN_PROGRESS,
    collectionStage,
    redact,
  };
});
