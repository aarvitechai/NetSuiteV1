/**
 * Writes entries to the "Northstar Integration Log" custom record.
 *
 * WHY a custom record and not just N/log: script execution logs are short-lived, have per-script
 * limits and are hard to search. A custom record can be searched, reported on and kept as long as
 * the business needs. That makes it the right place for an integration audit trail that NetSuite
 * admins look at.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/log', './nsd_constants', './nsd_rules'], (record, log, C, rules) => {
  /**
   * @param {{ correlationId: string, operation: string, status: 'SUCCESS'|'ERROR'|'WARNING',
   *           errorCode?: string, errorDetail?: string, recordType?: string, recordId?: string|number,
   *           idempotencyKey?: string }} entry
   * @returns {number|null} internal ID of the log record, or null if logging itself failed
   */
  function write(entry) {
    try {
      const rec = record.create({ type: C.RECORD.INT_LOG });
      const F = C.INT_LOG_FIELD;
      rec.setValue({ fieldId: 'name', value: `${entry.operation} ${entry.status}`.slice(0, 300) });
      rec.setValue({ fieldId: F.CORRELATION_ID, value: entry.correlationId || '' });
      rec.setValue({ fieldId: F.OPERATION, value: entry.operation });
      rec.setValue({ fieldId: F.STATUS, value: entry.status });
      rec.setValue({ fieldId: F.ERROR_CODE, value: entry.errorCode || '' });
      // Always redact: error detail can contain text that came from external systems.
      rec.setValue({ fieldId: F.ERROR_DETAIL, value: rules.redact(entry.errorDetail) });
      rec.setValue({ fieldId: F.RECORD_TYPE, value: entry.recordType || '' });
      rec.setValue({ fieldId: F.RECORD_ID, value: entry.recordId ? String(entry.recordId) : '' });
      rec.setValue({ fieldId: F.IDEM_KEY, value: entry.idempotencyKey || '' });
      return rec.save();
    } catch (e) {
      // Logging must never break the business transaction that called it, so report the problem and move on.
      log.error({ title: 'nsd_int_log.write failed', details: rules.redact(e && e.message) });
      return null;
    }
  }

  return { write };
});
