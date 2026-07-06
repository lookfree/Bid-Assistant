-- 个人资料库：按用户隔离的投标素材（六分类 + 结构化字段 + 附件引用）。
CREATE TABLE IF NOT EXISTS "library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"meta" text,
	"fields" jsonb,
	"expiry" text,
	"tags" jsonb,
	"attachments" jsonb,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_items_category_check" CHECK ("category" in ('qualification','performance','personnel','finance','text','presentation'))
);
CREATE INDEX IF NOT EXISTS "library_items_user_idx" ON "library_items" ("user_id");
