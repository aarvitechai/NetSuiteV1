/**
 * Saved search definitions used by Northstar scripts and dashboards.
 *
 * WHY definitions in code instead of only clicking them together in the UI:
 *  - They live in Git, so changes are reviewed and versioned.
 *  - Scripts can run the exact same search the finance team sees.
 *  - `saveAll()` (run once from a Suitelet / debugger) creates them as real saved searches.
 *
 * Filters use NetSuite "filter expressions": [field, operator, value] joined with 'AND' / 'OR'.
 * Status codes like 'VendBill:A' (Open) and 'CustInvc:A' (Open) are NetSuite's internal status IDs.
 * Verify them in your account (Reports → Saved Searches → status filter) before relying on them.
 *
 * Catalogue with intended users: docs/netsuite/saved-search-catalogue.md
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['N/search', './nsd_constants'], (search, C) => {
  /**
   * Each entry returns plain options for search.create(). Keeping them as functions means we can pass
   * parameters (e.g. "as of" date) without duplicating the definition.
   */
  const DEFINITIONS = {
    /** AP: open vendor bills that are not on hold and not already in a payment batch. */
    unpaidBills: () => ({
      id: 'customsearch_nsd_unpaid_bills',
      title: 'NSD AP - Unpaid Bills Eligible for Payment',
      type: search.Type.VENDOR_BILL,
      filters: [
        ['mainline', 'is', 'T'], // one row per bill, not one per line
        'AND',
        ['status', 'anyof', 'VendBill:A'], // Open
        'AND',
        [C.BODY.PAY_HOLD, 'is', 'F'],
        'AND',
        [C.BODY.PAY_IN_PROGRESS, 'is', 'F'],
      ],
      columns: ['tranid', 'entity', 'trandate', 'duedate', 'currency', 'amountremaining', 'externalid'],
    }),

    /** AR: open invoices past their due date (feeds the collections workflow). */
    overdueInvoices: () => ({
      id: 'customsearch_nsd_overdue_invoices',
      title: 'NSD AR - Overdue Invoices',
      type: search.Type.INVOICE,
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        ['status', 'anyof', 'CustInvc:A'], // Open
        'AND',
        ['duedate', 'before', 'today'],
        'AND',
        [C.BODY.DISPUTE, 'is', 'F'],
      ],
      columns: ['tranid', 'entity', 'duedate', 'amountremaining', 'currency', C.BODY.COLLECTION_STAGE],
    }),

    /** Ops: payment batches that were submitted but have no final status yet. */
    pendingPaymentBatches: () => ({
      id: 'customsearch_nsd_pending_batches',
      title: 'NSD Ops - Pending Payment Batches',
      type: C.RECORD.PAY_BATCH,
      filters: [['custrecord_nsd_pb_status', 'anyof', ['Submitted', 'Accepted']]],
      columns: [
        'custrecord_nsd_pb_batch_ref',
        'custrecord_nsd_pb_total',
        'custrecord_nsd_pb_status',
        'created',
      ],
    }),

    /** Ops: transactions whose last integration attempt failed. */
    failedIntegrations: () => ({
      id: 'customsearch_nsd_failed_integrations',
      title: 'NSD Ops - Failed Integrations',
      type: search.Type.TRANSACTION,
      filters: [['mainline', 'is', 'T'], 'AND', [C.BODY.INT_STATUS, 'is', C.INT_STATUS.ERROR]],
      columns: ['type', 'tranid', C.BODY.ERROR_DETAIL, C.BODY.CORRELATION_ID, 'lastmodifieddate'],
    }),

    /** Finance: reconciliation matches still waiting for a human decision. */
    unreconciledSettlements: () => ({
      id: 'customsearch_nsd_unreconciled',
      title: 'NSD Finance - Unreconciled Bank Lines',
      type: C.RECORD.RECON_MATCH,
      filters: [['custrecord_nsd_rm_status', 'isnot', 'APPROVED']],
      columns: [
        'custrecord_nsd_rm_bank_line_ref',
        'custrecord_nsd_rm_amount',
        'custrecord_nsd_rm_rule',
        'custrecord_nsd_rm_confidence',
      ],
    }),
  };

  /** Builds a search object (not saved) — use for running a search from a script. */
  function build(name) {
    const def = DEFINITIONS[name];
    if (!def) throw new Error(`Unknown search definition "${name}"`);
    const { type, filters, columns } = def();
    return search.create({ type, filters, columns });
  }

  /** Creates or overwrites all definitions as real saved searches (one-off admin action). */
  function saveAll() {
    return Object.keys(DEFINITIONS).map((name) => {
      const def = DEFINITIONS[name]();
      const s = search.create({ type: def.type, filters: def.filters, columns: def.columns });
      s.title = def.title;
      s.id = def.id;
      return s.save();
    });
  }

  return { DEFINITIONS, build, saveAll };
});
