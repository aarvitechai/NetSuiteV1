/**
 * Map/Reduce: update the collections stage of every overdue invoice.
 *
 * WHY MAP/REDUCE: there may be thousands of overdue invoices. Map/Reduce splits the work into small
 * pieces, runs them in parallel, and gives every stage its own governance budget. NetSuite also yields
 * and resumes the job automatically. A Scheduled Script processing thousands of records in one loop
 * would hit its usage limit.
 *
 * STAGES
 *  getInputData → returns a search; each result becomes one map() call.
 *  map          → computes the new stage for ONE invoice; emits only if the stage changes.
 *  reduce       → writes the new stage (one invoice per key, so there are no write conflicts).
 *  summarize    → counts updates and logs every error, with nothing silently lost.
 *
 * RESTART-SAFE DESIGN
 *  NetSuite may restart a map/reduce stage (for example after a server failover), so the same
 *  invoice can be processed twice. Our logic is idempotent:
 *   - the stage is computed deterministically from "days overdue" (rules.collectionStage);
 *   - we skip invoices that are already in that stage;
 *   - submitFields simply sets a value, so doing it twice has the same effect as doing it once.
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/record', 'N/log', '../lib/nsd_constants', '../lib/nsd_rules', '../lib/nsd_int_log'], (
  search,
  record,
  log,
  C,
  rules,
  intLog,
) => {
  function getInputData() {
    return search.create({
      type: search.Type.INVOICE,
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        ['status', 'anyof', 'CustInvc:A'], // Open
        'AND',
        ['duedate', 'before', 'today'],
      ],
      columns: [
        C.BODY.COLLECTION_STAGE,
        C.BODY.DISPUTE,
        // A formula column computes days overdue INSIDE NetSuite, so we do not have to parse dates that
        // are formatted according to each user's date preference.
        search.createColumn({ name: 'formulanumeric', formula: 'ROUND({today} - {duedate})' }),
      ],
    });
  }

  function map(context) {
    if (context.isRestarted) log.audit({ title: 'map restarted', details: context.key });

    // context.value is a JSON string of the search result: { id, recordType, values: {...} }
    const result = JSON.parse(context.value);
    const v = result.values;
    const daysOverdue = Number(v.formulanumeric);
    const disputed = v[C.BODY.DISPUTE] === true || v[C.BODY.DISPUTE] === 'T';
    const current = v[C.BODY.COLLECTION_STAGE] || C.COLLECTION_STAGE.NONE;
    const next = rules.collectionStage(daysOverdue, disputed);

    if (next !== current) context.write({ key: result.id, value: next });
  }

  function reduce(context) {
    // One key = one invoice. values[] has one entry (or duplicates after a restart, all identical).
    const stage = context.values[0];
    record.submitFields({
      type: record.Type.INVOICE,
      id: context.key,
      values: { [C.BODY.COLLECTION_STAGE]: stage },
      // Skip sourcing and mandatory-field checks: we change one custom field and nothing else.
      options: { enableSourcing: false, ignoreMandatoryFields: true },
    });
    context.write({ key: stage, value: context.key });
  }

  function summarize(summary) {
    const errors = [];
    if (summary.inputSummary.error) errors.push(`input: ${summary.inputSummary.error}`);
    summary.mapSummary.errors.iterator().each((key, err) => {
      errors.push(`map ${key}: ${err}`);
      return true;
    });
    summary.reduceSummary.errors.iterator().each((key, err) => {
      errors.push(`reduce ${key}: ${err}`);
      return true;
    });

    const counts = {};
    summary.output.iterator().each((stage) => {
      counts[stage] = (counts[stage] || 0) + 1;
      return true;
    });

    log.audit({ title: 'Collections stages updated', details: JSON.stringify(counts) });
    if (errors.length) {
      intLog.write({
        correlationId: `collections-${new Date().toISOString().slice(0, 10)}`,
        operation: 'COLLECTIONS_MR',
        status: 'ERROR',
        errorCode: 'MR_PARTIAL_FAILURE',
        errorDetail: errors.join('\n'),
      });
    }
    return { counts, errors };
  }

  return { getInputData, map, reduce, summarize };
});
