/**
 * RESTlet: a narrowly scoped endpoint for the middleware to read and update the INTEGRATION STATUS
 * fields of a transaction.
 *
 *   GET  ?type=vendorbill&id=123               → { id, type, status, providerRef, correlationId, errorDetail }
 *   PUT  { type, id, status, providerRef?, correlationId?, errorDetail? } → { ok: true }
 *
 * WHY A RESTLET HERE (and SuiteTalk REST elsewhere)?
 *  SuiteTalk REST is NetSuite's general record API: excellent for CRUD on standard records, but the
 *  integration role then needs broad permissions on those records. This RESTlet does ONE thing (it
 *  updates four custom fields) and validates everything. That gives:
 *    - least privilege: the endpoint cannot change amounts, vendors or anything else;
 *    - one round trip instead of a GET plus a PATCH;
 *    - business validation inside NetSuite.
 *
 * SECURITY RULES APPLIED (avoid an "over-permissive RESTlet")
 *  - Allow-list of record types (script parameter custscript_nsd_rl_allowed_types).
 *  - Allow-list of fields: callers can never choose which field to write.
 *  - Allow-list of status values.
 *  - Input lengths are limited and error text is redacted.
 *  - The deployment's audience should be ONLY the integration role (configured on the deployment).
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/runtime', 'N/error', '../lib/nsd_constants', '../lib/nsd_rules'], (
  record,
  runtime,
  error,
  C,
  rules,
) => {
  const DEFAULT_ALLOWED_TYPES = ['vendorbill', 'vendorpayment', 'invoice', 'customerpayment'];
  const ALLOWED_STATUSES = Object.values(C.INT_STATUS);

  function allowedTypes() {
    const param = runtime.getCurrentScript().getParameter({ name: C.PARAM.RL_ALLOWED_TYPES });
    return param
      ? String(param)
          .split(',')
          .map((s) => s.trim().toLowerCase())
      : DEFAULT_ALLOWED_TYPES;
  }

  function fail(code, message) {
    throw error.create({ name: code, message, notifyOff: true });
  }

  /** Validates type and id and returns them normalised. Shared by GET and PUT. */
  function target(input) {
    const type = String(input.type || '').toLowerCase();
    const id = String(input.id || '');
    if (!allowedTypes().includes(type)) fail('NSD_TYPE_NOT_ALLOWED', `Record type "${type}" is not allowed.`);
    if (!/^\d{1,12}$/.test(id)) fail('NSD_INVALID_ID', 'id must be a numeric internal ID.');
    return { type, id };
  }

  function get(requestParams) {
    const { type, id } = target(requestParams);
    const values = record.lookupFields({
      type,
      id,
      columns: [C.BODY.INT_STATUS, C.BODY.PROVIDER_REF, C.BODY.CORRELATION_ID, C.BODY.ERROR_DETAIL],
    });
    return {
      id,
      type,
      status: values[C.BODY.INT_STATUS] || null,
      providerRef: values[C.BODY.PROVIDER_REF] || null,
      correlationId: values[C.BODY.CORRELATION_ID] || null,
      errorDetail: values[C.BODY.ERROR_DETAIL] || null,
    };
  }

  function put(requestBody) {
    const body = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
    const { type, id } = target(body);
    if (!ALLOWED_STATUSES.includes(body.status))
      fail('NSD_INVALID_STATUS', `status must be one of ${ALLOWED_STATUSES.join(', ')}`);

    const values = { [C.BODY.INT_STATUS]: body.status };
    if (body.providerRef !== undefined) values[C.BODY.PROVIDER_REF] = String(body.providerRef).slice(0, 300);
    if (body.correlationId !== undefined)
      values[C.BODY.CORRELATION_ID] = String(body.correlationId).slice(0, 100);
    if (body.errorDetail !== undefined) values[C.BODY.ERROR_DETAIL] = rules.redact(body.errorDetail);

    record.submitFields({
      type,
      id,
      values,
      options: { enableSourcing: false, ignoreMandatoryFields: true },
    });
    return { ok: true, id, type };
  }

  return { get, put };
});
