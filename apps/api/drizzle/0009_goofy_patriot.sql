CREATE INDEX IF NOT EXISTS "payment_orders_status_idx" ON "payment_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_status_check" CHECK ("referrals"."status" in ('pending','bound','frozen'));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_reward_state_check" CHECK ("referrals"."reward_state" in ('pending','unlocked','capped'));--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_billing_cycle_check" CHECK ("plans"."billing_cycle" in ('month','quarter','year'));