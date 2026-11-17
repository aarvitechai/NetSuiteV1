-- name: integration_exceptions
-- users: operations / support dashboard
-- purpose: transactions whose last integration attempt failed, newest first.
SELECT
  t.id,
  t.type,
  t.tranid,
  t.custbody_nsd_correlation_id       AS correlation_id,
  t.custbody_nsd_error_detail         AS error_detail,
  t.lastmodifieddate
FROM transaction t
WHERE t.custbody_nsd_int_status = 'ERROR'
ORDER BY t.lastmodifieddate DESC
