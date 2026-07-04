ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_order_id_payment_orders_id_fk";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_payment_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE;
