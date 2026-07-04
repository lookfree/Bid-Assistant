ALTER TABLE "reconcile_diffs" ADD COLUMN IF NOT EXISTS "subject" text;
UPDATE "reconcile_diffs" SET "subject" = coalesce("trade_no", "user_id"::text, "id"::text) WHERE "subject" IS NULL;
ALTER TABLE "reconcile_diffs" DROP CONSTRAINT IF EXISTS "reconcile_diffs_type_check";
ALTER TABLE "reconcile_diffs" ADD CONSTRAINT "reconcile_diffs_type_check"
  CHECK ("diff_type" in ('amount_mismatch','status_mismatch','unknown_paid','provider_missing','ledger_mismatch','orphan_hold','refund_stuck'));
CREATE UNIQUE INDEX IF NOT EXISTS "reconcile_diffs_open_subject_uq"
  ON "reconcile_diffs" ("diff_type", "subject") WHERE "resolved" = 'open';
CREATE INDEX IF NOT EXISTS "credit_tx_type_created_idx" ON "credit_transactions" ("type", "created_at");
CREATE INDEX IF NOT EXISTS "credit_tx_ref_idx" ON "credit_transactions" ("ref");
