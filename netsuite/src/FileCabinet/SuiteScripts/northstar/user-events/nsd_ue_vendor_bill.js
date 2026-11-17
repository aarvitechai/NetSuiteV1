/**
 * User Event script on Vendor Bill.
 *
 * WHAT IT DOES
 *  beforeSubmit (runs on the server just before the record is saved):
 *   1. Validates the required fields (invoice number, positive total, due date ≥ bill date).
 *   2. Blocks a duplicate vendor invoice number for the same vendor.
 *   3. Blocks edits to amount/vendor/currency while the bill is in a submitted payment batch.
 *   4. Sets the integration metadata defaults (integration status = PENDING on create).
 *  afterSubmit (runs after the save): writes an audit entry for bills created by integrations.
 *
 * WHY A USER EVENT (and not a Client Script)?
 *  User Events run on the SERVER for every save, whether it comes from the UI, CSV import, SuiteTalk,
 *  a RESTlet or another script. A Client Script only runs in a browser and can be bypassed, so it is
 *  NOT a security or data-integrity boundary.
 *
 * GOVERNANCE: the duplicate search costs ~10 units. The 1,000 units available to a User Event are plenty.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
  'N/search',
  'N/error',
  'N/runtime',
  'N/log',
  '../lib/nsd_constants',
  '../lib/nsd_rules',
  '../lib/nsd_int_log',
], (search, error, runtime, log, C, rules, intLog) => {
  /** Reads the fields our rules need into a plain object, so the rules stay NetSuite-agnostic. */
  function snapshot(rec) {
    return {
      tranId: rec.getValue({ fieldId: 'tranid' }),
      total: Number(rec.getValue({ fieldId: 'usertotal' })),
      tranDate: rec.getValue({ fieldId: 'trandate' }),
      dueDate: rec.getValue({ fieldId: 'duedate' }),
      entity: rec.getValue({ fieldId: 'entity' }),
      currency: rec.getValue({ fieldId: 'currency' }),
      usertotal: rec.getValue({ fieldId: 'usertotal' }),
      tranid: rec.getValue({ fieldId: 'tranid' }),
    };
  }

  /** Throws a NetSuite error that the UI shows to the user and that SuiteTalk returns to the caller. */
  function reject(code, message) {
    throw error.create({ name: code, message, notifyOff: true });
  }

  /**
   * True if another bill from the same vendor already uses this invoice number.
   * WHY: paying the same vendor invoice twice is one of the most common (and costly) AP errors.
   */
  function isDuplicateInvoiceNumber(vendorId, tranId, currentId) {
    const filters = [
      ['mainline', 'is', 'T'],
      'AND',
      ['entity', 'anyof', vendorId],
      'AND',
      ['tranid', 'is', tranId],
    ];
    // When editing, exclude the bill itself from the search.
    if (currentId) filters.push('AND', ['internalid', 'noneof', currentId]);
    return (
      search
        .create({ type: search.Type.VENDOR_BILL, filters, columns: ['internalid'] })
        .runPaged({ pageSize: 5 }).count > 0
    );
  }

  function beforeSubmit(context) {
    const { CREATE, EDIT, XEDIT } = context.UserEventType;
    // Only validate real changes. DELETE, APPROVE etc. are not our concern here.
    if (![CREATE, EDIT, XEDIT].includes(context.type)) return;

    const rec = context.newRecord;
    const now = snapshot(rec);

    // XEDIT (inline edit) only contains the changed fields, so we skip full validation for it, but we
    // still enforce the "locked while in progress" rule below.
    if (context.type !== XEDIT) {
      const problems = rules.validateVendorBill(now);
      if (problems.length) reject('NSD_VALIDATION_FAILED', problems.join(' '));

      if (now.entity && now.tranId && isDuplicateInvoiceNumber(now.entity, now.tranId, rec.id)) {
        reject('NSD_DUPLICATE_BILL', `Vendor invoice number "${now.tranId}" already exists for this vendor.`);
      }
    }

    if (context.type !== CREATE && context.oldRecord) {
      const inProgress = context.oldRecord.getValue({ fieldId: C.BODY.PAY_IN_PROGRESS });
      if (inProgress === true || inProgress === 'T') {
        // On XEDIT, newRecord holds only the submitted fields, so unchanged fields would look "emptied".
        // getFields() tells us which fields were actually submitted. (Verify this behaviour in your sandbox.)
        const submitted = context.type === XEDIT ? rec.getFields() : null;
        const changed = rules
          .changedLockedFields(snapshot(context.oldRecord), now)
          .filter((f) => submitted === null || submitted.includes(f));
        if (changed.length) {
          reject(
            'NSD_BILL_LOCKED',
            `Bill is in a submitted payment batch. Locked fields changed: ${changed.join(', ')}.`,
          );
        }
      }
    }

    if (context.type === CREATE && !rec.getValue({ fieldId: C.BODY.INT_STATUS })) {
      rec.setValue({ fieldId: C.BODY.INT_STATUS, value: C.INT_STATUS.PENDING });
    }
  }

  function afterSubmit(context) {
    if (context.type !== context.UserEventType.CREATE) return;
    // Only audit bills created by integrations. UI-created bills already have NetSuite's System Notes.
    const ctx = runtime.executionContext;
    if (
      ctx !== runtime.ContextType.REST_WEBSERVICES &&
      ctx !== runtime.ContextType.WEBSERVICES &&
      ctx !== runtime.ContextType.RESTLET
    ) {
      return;
    }
    const rec = context.newRecord;
    intLog.write({
      correlationId: rec.getValue({ fieldId: C.BODY.CORRELATION_ID }),
      operation: 'VENDOR_BILL_CREATED',
      status: 'SUCCESS',
      recordType: 'vendorbill',
      recordId: rec.id,
      idempotencyKey: rec.getValue({ fieldId: C.BODY.IDEM_KEY }),
    });
    log.audit({ title: 'Vendor bill created via integration', details: `id=${rec.id}` });
  }

  return { beforeSubmit, afterSubmit };
});
