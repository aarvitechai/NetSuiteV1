-- name: settlement_matching
-- users: reconciliation engine (middleware)
-- purpose: candidate NetSuite payments and deposits for matching bank lines in a date window.
-- params: :from_date, :to_date (ISO dates)
SELECT
  t.id,
  t.type,
  t.tranid,
  t.trandate,
  t.foreigntotal                      AS amount,
  BUILTIN.DF(t.currency)              AS currency,
  t.externalid,
  t.custbody_nsd_provider_ref         AS provider_ref,
  t.custbody_nsd_ext_pay_ref          AS ext_pay_ref
FROM transaction t
WHERE t.type IN ('VendPymt', 'CustPymt', 'Deposit', 'CustRfnd')
  AND t.trandate BETWEEN TO_DATE(:from_date, 'YYYY-MM-DD') AND TO_DATE(:to_date, 'YYYY-MM-DD')
ORDER BY t.trandate, t.id
