ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "device_hash" text;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "signup_ip" text;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "frozen_reason" text;
CREATE INDEX IF NOT EXISTS "referrals_signup_ip_idx" ON "referrals" ("signup_ip");
CREATE TABLE IF NOT EXISTS "referral_codes" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "referral_codes_code_unique" UNIQUE ("code")
);
CREATE TABLE IF NOT EXISTS "referral_risk_audits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid,
  "invitee_id" uuid,
  "reason" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "referral_risk_invitee_idx" ON "referral_risk_audits" ("invitee_id");
