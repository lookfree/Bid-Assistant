-- 步骤真实耗时（2026-08-17 用户要求「整步进度条 + 预估总时间」）：此前 project_steps 只有
-- created_at（= run 起步时刻），收尾是**原地 UPDATE 同一行**，结束时刻根本没落库，
-- 预估只能靠「相邻步 created_at 之差」这种把用户发呆时间也算进去的近似。
-- 补一列结束时刻，收尾时写入；ETA 取历史 (finished_at - created_at) 的中位数。
ALTER TABLE "project_steps" ADD COLUMN IF NOT EXISTS "finished_at" timestamptz;
-- 按 (step, finished_at) 取最近 N 条算中位：没索引就要全表扫 project_steps。
CREATE INDEX IF NOT EXISTS "project_steps_step_finished_idx"
  ON "project_steps" ("step", "finished_at" DESC) WHERE "finished_at" IS NOT NULL;
