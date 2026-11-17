/**
 * Scheduled Script: find "stuck" payments.
 *
 * WHAT IT DOES: finds vendor bills flagged "Payment In Progress" that have not been modified for N days
 * (script parameter custscript_nsd_ss_stale_days, default 5). Each one gets an Integration Log
 * WARNING, so operations can check with the bank whether that payment was ever settled or rejected.
 *
 * WHY A SCHEDULED SCRIPT: this is periodic maintenance (for example nightly). It has no user and no
 * record event to react to, which is exactly what scheduled scripts are for.
 *
 * GOVERNANCE: a scheduled script has 10,000 usage units. Each log write costs units, so we check
 * getRemainingUsage() and, before running out, RESCHEDULE ourselves with N/task instead of crashing
 * halfway. Because we only *report* (we change nothing on the bill), running twice is harmless.
 *
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/runtime', 'N/task', 'N/log', '../lib/nsd_constants', '../lib/nsd_int_log'], (
  search,
  runtime,
  task,
  log,
  C,
  intLog,
) => {
  /** Stop well before the limit so that rescheduling itself has enough units left. */
  const USAGE_SAFETY_MARGIN = 200;

  function execute() {
    const script = runtime.getCurrentScript();
    const staleDays = Number(script.getParameter({ name: C.PARAM.SS_STALE_DAYS })) || 5;

    const staleSearch = search.create({
      type: search.Type.VENDOR_BILL,
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        [C.BODY.PAY_IN_PROGRESS, 'is', 'T'],
        'AND',
        // "daysago5" is NetSuite's relative-date syntax: last modified more than N days ago.
        ['lastmodifieddate', 'before', `daysago${staleDays}`],
      ],
      columns: ['tranid', C.BODY.PAY_BATCH_REF, 'lastmodifieddate'],
    });

    let reported = 0;
    let rescheduled = false;

    // each() processes up to 4,000 results. Returning false stops the loop early.
    staleSearch.run().each((result) => {
      if (script.getRemainingUsage() < USAGE_SAFETY_MARGIN) {
        task
          .create({
            taskType: task.TaskType.SCHEDULED_SCRIPT,
            scriptId: script.id,
            deploymentId: script.deploymentId,
          })
          .submit();
        rescheduled = true;
        return false;
      }
      intLog.write({
        correlationId: `stale-scan-${new Date().toISOString().slice(0, 10)}`,
        operation: 'STALE_PAYMENT_DETECTED',
        status: 'WARNING',
        errorCode: 'PAYMENT_STALE',
        errorDetail: `Bill ${result.getValue({ name: 'tranid' })} in batch ${result.getValue({ name: C.BODY.PAY_BATCH_REF })} has been in progress more than ${staleDays} days.`,
        recordType: 'vendorbill',
        recordId: result.id,
      });
      reported++;
      return true;
    });

    log.audit({
      title: 'Stale payment scan finished',
      details: JSON.stringify({ reported, rescheduled, staleDays }),
    });
    return { reported, rescheduled };
  }

  return { execute };
});
