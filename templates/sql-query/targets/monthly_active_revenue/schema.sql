CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  segment TEXT NOT NULL,
  is_active INTEGER NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  refund_cents INTEGER NOT NULL
);

CREATE INDEX idx_customers_active ON customers (is_active, id);
CREATE INDEX idx_orders_month_status_cust ON orders (month, status, customer_id, gross_cents);
CREATE INDEX idx_orders_cust ON orders (customer_id);
CREATE INDEX idx_refunds_order ON refunds (order_id, refund_cents);
