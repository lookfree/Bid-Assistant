-- 退款幂等：部分退款重试(同意图)会绕过累计封顶导致重复退真钱。加幂等键 + 部分唯一索引。
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_idempotency_key_uq" ON "refunds" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
