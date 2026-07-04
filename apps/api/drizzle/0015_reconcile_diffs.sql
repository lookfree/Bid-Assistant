CREATE TABLE IF NOT EXISTS "reconcile_diffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bill_date" text NOT NULL,
  "diff_type" text NOT NULL,
  "trade_no" text,
  "order_id" uuid,
  "user_id" uuid,
  "local_value" text,
  "bill_value" text,
  "resolved" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reconcile_diffs_type_check" CHECK ("diff_type" in ('amount_mismatch','status_mismatch','unknown_paid','provider_missing','ledger_mismatch','orphan_hold')),
  CONSTRAINT "reconcile_diffs_resolved_check" CHECK ("resolved" in ('open','resolved'))
);
CREATE INDEX IF NOT EXISTS "reconcile_diffs_date_idx" ON "reconcile_diffs" ("bill_date");
CREATE INDEX IF NOT EXISTS "reconcile_diffs_open_idx" ON "reconcile_diffs" ("resolved");
