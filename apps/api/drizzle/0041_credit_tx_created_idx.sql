-- 账本页「全部用户」视图按 created_at desc 分页 + count(*) 全表统计：
-- credit_transactions 此前只有 user_id / (user_id, expire_at) 索引，无 where 的查询会全表扫 + 外部排序。
CREATE INDEX IF NOT EXISTS "credit_tx_created_idx" ON "credit_transactions" ("created_at" DESC);
