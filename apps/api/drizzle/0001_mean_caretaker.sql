DROP INDEX IF EXISTS "sessions_token_hash_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_uq" UNIQUE("token_hash");