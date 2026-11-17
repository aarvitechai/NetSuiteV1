-- name: vendor_payment_status
-- users: AP clerk, operations
-- purpose: bills currently in a payment batch, with batch reference and integration status.
-- params: :batch_ref (string)
SELECT
  t.id,
  t.tranid,
  BUILTIN.DF(t.entity)               AS vendor_name,
  t.custbody_nsd_pay_batch_ref        AS batch_ref,
  t.custbody_nsd_int_status           AS integration_status,
  t.custbody_nsd_provider_ref         AS provider_ref,
  BUILTIN.DF(t.status)                AS ns_status
FROM transaction t
WHERE t.type = 'VendBill'
  AND t.custbody_nsd_pay_batch_ref = :batch_ref
ORDER BY t.id
