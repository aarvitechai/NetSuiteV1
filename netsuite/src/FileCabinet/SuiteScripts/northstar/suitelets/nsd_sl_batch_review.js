/**
 * Suitelet: read-only "Payment Batch Review" page for AP and operations users.
 *
 * WHY A SUITELET: Suitelets are custom pages inside NetSuite, so users see batch status without leaving
 * NetSuite and without needing access to the middleware.
 *
 * WHY READ-ONLY: approving a batch (maker-checker) happens in the middleware, where the approval is
 * recorded together with the bank file checksum. Having a second approval path here would let the two
 * disagree. NetSuite roles control who may open this page (set on the script deployment's Audience).
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/ui/serverWidget', 'N/search', '../lib/nsd_constants'], (serverWidget, search, C) => {
  const MAX_ROWS = 500; // keep the page fast; use the saved search for full history

  const COLUMNS = [
    { id: 'custrecord_nsd_pb_batch_ref', label: 'Batch Reference' },
    { id: 'custrecord_nsd_pb_rail', label: 'Rail' },
    { id: 'custrecord_nsd_pb_currency', label: 'Currency' },
    { id: 'custrecord_nsd_pb_total', label: 'Total' },
    { id: 'custrecord_nsd_pb_count', label: 'Items' },
    { id: 'custrecord_nsd_pb_status', label: 'Status' },
    { id: 'custrecord_nsd_pb_maker', label: 'Maker' },
    { id: 'custrecord_nsd_pb_checker', label: 'Checker' },
  ];

  function onRequest(context) {
    if (context.request.method !== 'GET') {
      // Explicitly refuse other methods so this page can never be used to change data.
      context.response.write({ output: 'Method not allowed' });
      return;
    }

    const statusFilter = context.request.parameters.status; // optional ?status=Submitted
    const filters = statusFilter ? [['custrecord_nsd_pb_status', 'is', statusFilter]] : [];

    const form = serverWidget.createForm({ title: 'Northstar – Payment Batch Review' });
    const sublist = form.addSublist({
      id: 'custpage_batches',
      type: serverWidget.SublistType.LIST,
      label: 'Payment Batches',
    });
    COLUMNS.forEach((c) =>
      sublist.addField({ id: `custpage_${c.id}`, type: serverWidget.FieldType.TEXT, label: c.label }),
    );

    const results = search
      .create({ type: C.RECORD.PAY_BATCH, filters, columns: COLUMNS.map((c) => c.id) })
      .run()
      .getRange({ start: 0, end: MAX_ROWS });

    results.forEach((r, line) => {
      COLUMNS.forEach((c) => {
        const value = r.getValue({ name: c.id });
        // setSublistValue throws on empty strings, so only set columns that have a value.
        if (value !== '' && value !== null && value !== undefined) {
          sublist.setSublistValue({ id: `custpage_${c.id}`, line, value: String(value) });
        }
      });
    });

    context.response.writePage(form);
  }

  return { onRequest };
});
