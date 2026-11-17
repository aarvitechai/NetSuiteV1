-- name: invoice_aging
-- users: AR clerk, controller (month-end aging report)
-- purpose: open customer invoices bucketed by days past due, as of today.
SELECT
  t.id,
  t.tranid,
  BUILTIN.DF(t.entity)        AS customer,
  t.duedate,
  BUILTIN.DF(t.currency)      AS currency,
  t.foreignamountremaining    AS amount_remaining,
  CASE
    WHEN t.duedate >= TRUNC(SYSDATE)        THEN 'CURRENT'
    WHEN TRUNC(SYSDATE) - t.duedate <= 30   THEN '1-30'
    WHEN TRUNC(SYSDATE) - t.duedate <= 60   THEN '31-60'
    WHEN TRUNC(SYSDATE) - t.duedate <= 90   THEN '61-90'
    ELSE '90+'
  END                         AS aging_bucket
FROM transaction t
WHERE t.type = 'CustInvc'
  AND t.foreignamountremaining > 0
ORDER BY t.duedate
