-- spec315b：终极审核表持久化 + 查重审计。
-- project_checklists：userId + 可空 projectId（无项目 = 独立工具的用户级默认行）。
-- 唯一约束 (user_id, project_id) 用 NULLS NOT DISTINCT（远端 PG 16.1 ≥ 15 已确认）：
-- 否则 project_id IS NULL 的默认行可无限重复，upsert 的 ON CONFLICT 也无从命中。
CREATE TABLE IF NOT EXISTS "project_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"project_id" uuid REFERENCES "bid_projects"("id") ON DELETE CASCADE,
	"items" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_checklists_user_project_uq" UNIQUE NULLS NOT DISTINCT ("user_id", "project_id")
);
-- dedupe_runs：查重审计行（100 分/次的操作要可追溯）；随用户级联删。
CREATE TABLE IF NOT EXISTS "dedupe_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"params" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "dedupe_runs_user_idx" ON "dedupe_runs" ("user_id");
