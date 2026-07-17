-- spec326：反馈/投诉入口（算法备案要求「投诉/申诉入口且处理可追溯」）。money-blind：不与积分账本交互。
-- 项目被删不应删掉反馈记录，project_id 用 ON DELETE SET NULL（而非 CASCADE）。
CREATE TABLE IF NOT EXISTS "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"type" text NOT NULL,
	"project_id" uuid REFERENCES "bid_projects"("id") ON DELETE SET NULL,
	"content" text NOT NULL,
	"contact" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reply" text,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_type_check" CHECK ("type" in ('content_error','complaint','billing','suggestion','other')),
	CONSTRAINT "feedback_status_check" CHECK ("status" in ('pending','processing','resolved'))
);
CREATE INDEX IF NOT EXISTS "feedback_status_idx" ON "feedback" ("status","created_at");
CREATE INDEX IF NOT EXISTS "feedback_user_idx" ON "feedback" ("user_id","created_at");
