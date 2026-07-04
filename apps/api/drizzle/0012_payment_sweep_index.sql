CREATE INDEX IF NOT EXISTS "payment_orders_created_sweep_idx" ON "payment_orders" ("created_at") WHERE "payment_orders"."status" = 'created';
