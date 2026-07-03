ALTER TABLE "payment_orders" ADD COLUMN IF NOT EXISTS "plan_id" uuid REFERENCES "plans"("id");
CREATE TABLE IF NOT EXISTS "renewal_reminders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "period_end" timestamp with time zone NOT NULL,
  "tier" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "renewal_reminders_uq" UNIQUE ("subscription_id", "period_end", "tier")
);
