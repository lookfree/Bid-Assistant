ALTER TABLE "credit_transactions" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amount_positive" CHECK ("payment_orders"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0);