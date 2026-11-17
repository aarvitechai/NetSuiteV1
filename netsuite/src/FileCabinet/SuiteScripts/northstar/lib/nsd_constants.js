/**
 * Northstar constants shared by all SuiteScripts.
 *
 * WHY: Field IDs like "custbody_nsd_pay_hold" are typed in many scripts. If one script misspells one,
 * NetSuite silently returns an empty value instead of throwing an error — a very hard bug to find.
 * Keeping every ID in ONE module (and testing that each has an SDF object, see
 * netsuite/tests/sdf-objects.test.ts) removes that whole class of bug.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define([], () => {
  /** Transaction body custom fields (Objects/custbody_*.xml). */
  const BODY = Object.freeze({
    EXT_PAY_REF: 'custbody_nsd_ext_pay_ref',
    PROVIDER_REF: 'custbody_nsd_provider_ref',
    INT_STATUS: 'custbody_nsd_int_status',
    IDEM_KEY: 'custbody_nsd_idem_key',
    CORRELATION_ID: 'custbody_nsd_correlation_id',
    ERROR_DETAIL: 'custbody_nsd_error_detail',
    PAY_IN_PROGRESS: 'custbody_nsd_pay_in_progress',
    PAY_HOLD: 'custbody_nsd_pay_hold',
    PAY_BATCH_REF: 'custbody_nsd_pay_batch_ref',
    COLLECTION_STAGE: 'custbody_nsd_collection_stage',
    DISPUTE: 'custbody_nsd_dispute',
  });

  /** Entity (vendor/customer) custom fields (Objects/custentity_*.xml). */
  const ENTITY = Object.freeze({
    EXT_ID_SOURCE: 'custentity_nsd_ext_id_src',
    PAY_METHOD: 'custentity_nsd_pay_method',
    BANK_TOKEN: 'custentity_nsd_bank_token',
  });

  /** Custom record types and their fields (Objects/customrecord_*.xml). */
  const RECORD = Object.freeze({
    PAY_BATCH: 'customrecord_nsd_pay_batch',
    INT_LOG: 'customrecord_nsd_int_log',
    RECON_MATCH: 'customrecord_nsd_recon_match',
  });

  const INT_LOG_FIELD = Object.freeze({
    CORRELATION_ID: 'custrecord_nsd_il_correlation_id',
    OPERATION: 'custrecord_nsd_il_operation',
    STATUS: 'custrecord_nsd_il_status',
    ERROR_CODE: 'custrecord_nsd_il_error_code',
    ERROR_DETAIL: 'custrecord_nsd_il_error_detail',
    RECORD_TYPE: 'custrecord_nsd_il_record_type',
    RECORD_ID: 'custrecord_nsd_il_record_id',
    IDEM_KEY: 'custrecord_nsd_il_idem_key',
  });

  /** Integration status values written to BODY.INT_STATUS. */
  const INT_STATUS = Object.freeze({
    PENDING: 'PENDING',
    SYNCED: 'SYNCED',
    ERROR: 'ERROR',
  });

  /** Collection stages used by the AR collections workflow (Phase 4). */
  const COLLECTION_STAGE = Object.freeze({
    NONE: 'NONE',
    REMINDER_1: 'REMINDER_1',
    REMINDER_2: 'REMINDER_2',
    ESCALATED: 'ESCALATED',
  });

  /** Script parameter IDs (set on the script deployment record, not hard-coded). */
  const PARAM = Object.freeze({
    MR_MAX_BILLS: 'custscript_nsd_mr_max_bills',
    SS_STALE_DAYS: 'custscript_nsd_ss_stale_days',
    RL_ALLOWED_TYPES: 'custscript_nsd_rl_allowed_types',
  });

  return { BODY, ENTITY, RECORD, INT_LOG_FIELD, INT_STATUS, COLLECTION_STAGE, PARAM };
});
