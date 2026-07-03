CREATE TABLE IF NOT EXISTS "bid_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"tender_file_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_step" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bid_projects_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"step" text NOT NULL,
	"run_id" text,
	"result" jsonb,
	"cost_points" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bid_projects" ADD CONSTRAINT "bid_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_steps" ADD CONSTRAINT "project_steps_project_id_bid_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."bid_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_projects_user_idx" ON "bid_projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_steps_proj_idx" ON "project_steps" USING btree ("project_id");