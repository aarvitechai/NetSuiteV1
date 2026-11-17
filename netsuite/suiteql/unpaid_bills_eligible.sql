-- name: unpaid_bills_eligible
-- users: middleware payment-proposal service
-- purpose: approved, open vendor bills not on hold and not already in a payment batch, due by :due_by.
-- params: :due_by (ISO date)
SELECT
  t.id,
  t.tranid,
  t.externalid,
  t.entity                    AS vendor_id,
  BUILTIN.DF(t.entity)        AS vendor_name,
  t.duedate,
  BUILTIN.DF(t.currency)      AS currency,
  t.foreignamountremaining    AS amount_remaining
FROM transaction t
WHERE t.type = 'VendBill'
  AND t.approvalstatus = 2                       -- 2 = Approved (verify in your account)
  AND t.foreignamountremaining > 0
  AND NVL(t.custbody_nsd_pay_hold, 'F') = 'F'
  AND NVL(t.custbody_nsd_pay_in_progress, 'F') = 'F'
  AND t.duedate <= TO_DATE(:due_by, 'YYYY-MM-DD')
ORDER BY t.duedate, t.id
