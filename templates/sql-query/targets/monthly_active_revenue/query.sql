SELECT
  o.month AS month,
  (
    SELECT c2.segment
    FROM customers c2
    WHERE c2.id = o.customer_id
  ) AS segment,
  COUNT(*) AS paid_orders,
  SUM(
    o.gross_cents - COALESCE((
      SELECT SUM(r.refund_cents)
      FROM refunds r
      WHERE r.order_id = o.id
    ), 0)
  ) AS net_cents
FROM orders o
WHERE o.status = 'paid'
  AND o.customer_id IN (
    SELECT c.id
    FROM customers c
    WHERE c.is_active = 1
  )
  AND EXISTS (
    SELECT 1
    FROM orders o2
    WHERE o2.customer_id = o.customer_id
      AND o2.status = 'paid'
  )
GROUP BY o.month, (
  SELECT c3.segment
  FROM customers c3
  WHERE c3.id = o.customer_id
)
ORDER BY o.month ASC, segment ASC
