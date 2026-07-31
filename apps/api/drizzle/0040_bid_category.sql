-- 标书分类（spec334）：货物 / 服务 / 工程。
-- ① bid_category 是**用户确认值**，与读标产出的判定值分开存——合并成一列的话，重跑读标会把
--    用户的改判悄悄冲掉。判定值留在 project_steps.result 里，只读不覆盖。
-- ② 三态语义：NULL = 用户没表态（回落判定值）；非空数组 = 用户选定；**'[]' = 用户明确不用分类**。
--    第三态不可省：判定给了一个用户认为都不合适的类别时，他得有办法关掉，否则每次重跑都被强加一次。
-- ③ 有序数组而非单值：平台采购这类标同时是货物与服务，硬选一个会丢掉另一半的必查项，
--    而必查项漏一条就是废标。首元素为主类别。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "bid_category" jsonb;

-- 纠偏样本：判定值非空且与用户确认值不同时记一条，是判定质量迭代的唯一数据来源。
-- **判定值为空时的用户选择不记**——那是覆盖率问题不是准确率问题，混进来会淹没真正的判错信号。
CREATE TABLE IF NOT EXISTS "bid_category_corrections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "bid_projects"("id") ON DELETE CASCADE,
  "detected" jsonb NOT NULL,
  "confirmed" jsonb NOT NULL,
  "confidence" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "bid_category_corrections_created_idx"
  ON "bid_category_corrections" ("created_at");
