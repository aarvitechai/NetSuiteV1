/**
 * Client Script on the Vendor Bill form.
 *
 * WHAT IT DOES: gives the AP clerk instant feedback in the browser.
 *  - fieldChanged: warns when the due date is before the bill date, and explains the payment hold flag.
 *  - saveRecord:   blocks saving when the rules fail (the same rules the server enforces).
 *
 * WHY BOTH CLIENT AND SERVER VALIDATION?
 *  The client check is for user EXPERIENCE (fast feedback without a round trip).
 *  The User Event (nsd_ue_vendor_bill.js) is for data INTEGRITY. Client code can be bypassed (CSV
 *  import, web services, or simply browser dev tools), so it is never a security boundary.
 *  Both call the same lib/nsd_rules.js, so the two can never disagree.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/ui/dialog', '../lib/nsd_constants', '../lib/nsd_rules'], (dialog, C, rules) => {
  function read(rec) {
    return {
      tranId: rec.getValue({ fieldId: 'tranid' }),
      total: Number(rec.getValue({ fieldId: 'usertotal' })),
      tranDate: rec.getValue({ fieldId: 'trandate' }),
      dueDate: rec.getValue({ fieldId: 'duedate' }),
    };
  }

  function fieldChanged(context) {
    const rec = context.currentRecord;
    if (context.fieldId === 'duedate' || context.fieldId === 'trandate') {
      const { tranDate, dueDate } = read(rec);
      if (tranDate && dueDate && dueDate < tranDate) {
        dialog.alert({ title: 'Check due date', message: 'The due date is before the bill date.' });
      }
    }
    if (context.fieldId === C.BODY.PAY_HOLD && rec.getValue({ fieldId: C.BODY.PAY_HOLD }) === true) {
      dialog.alert({
        title: 'Payment hold',
        message: 'This bill will be excluded from payment proposals until the hold is removed.',
      });
    }
  }

  /** Returning false cancels the save. */
  function saveRecord(context) {
    const problems = rules.validateVendorBill(read(context.currentRecord));
    if (problems.length) {
      dialog.alert({ title: 'Cannot save bill', message: problems.join('<br>') });
      return false;
    }
    return true;
  }

  return { fieldChanged, saveRecord };
});
