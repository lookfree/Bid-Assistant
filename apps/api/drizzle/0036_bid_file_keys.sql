-- 线下标书多文件（商务标/技术标常常分册出卷）：与 tender_file_keys 同构，
-- bid_file_key 保留为 bid_file_keys[0]，旧读侧不动即可继续工作。存量行留 null，
-- 读侧一律 `bidFileKeys ?? [bidFileKey]` 兜底，无需回填。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "bid_file_keys" jsonb;
