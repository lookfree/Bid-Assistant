DELETE FROM "subscriptions" a USING "subscriptions" b
  WHERE a."user_id" = b."user_id"
    AND (a."created_at" < b."created_at" OR (a."created_at" = b."created_at" AND a."id" < b."id"));
DROP INDEX IF EXISTS "subscriptions_user_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_user_uq" ON "subscriptions" ("user_id");
ALTER TABLE "payment_orders" ADD COLUMN IF NOT EXISTS "cycle_snapshot" text;
