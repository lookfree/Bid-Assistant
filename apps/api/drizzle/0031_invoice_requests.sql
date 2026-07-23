-- spec332 / YFZQ-3：会员中心开发票。money-blind：只引用订单+快照金额，不与积分账本交互。
-- 一单一票用部分唯一索引（pending/issued 占用；rejected 释放，可重新申请）。本期运营手工开票，
-- invoice_no/file_url 预留给未来三方电子发票自动开具。
CREATE TABLE IF NOT EXISTS "invoice_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"order_id" uuid NOT NULL REFERENCES "payment_orders"("id"),
	"amount_cents" integer NOT NULL,
	"title_type" text NOT NULL,
	"title" text NOT NULL,
	"tax_no" text,
	"email" text NOT NULL,
	"remark" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"invoice_no" text,
	"file_url" text,
	"reject_reason" text,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_title_type_check" CHECK ("title_type" in ('personal','enterprise')),
	CONSTRAINT "invoice_status_check" CHECK ("status" in ('pending','issued','rejected')),
	CONSTRAINT "invoice_amount_check" CHECK ("amount_cents" > 0)
);
CREATE INDEX IF NOT EXISTS "invoice_requests_user_idx" ON "invoice_requests" ("user_id","created_at");
CREATE INDEX IF NOT EXISTS "invoice_requests_status_idx" ON "invoice_requests" ("status","created_at");
-- 一单一票：仅约束进行中/已开，rejected 不占用（可重新申请）。
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_requests_active_order_uniq" ON "invoice_requests" ("order_id") WHERE "status" in ('pending','issued');
