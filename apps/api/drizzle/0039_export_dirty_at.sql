-- 导出计费口径修正（评审 2026-07-31）：
-- ① content_changed_at：内容最后一次变更时间。导出收尾只有在「本次 run 起步之后内容没再变过」
--    时才清脏——否则用户在长达数分钟的导出期间改了章节，收尾会把这次改动一并抹平，
--    交付的文件不含改动，下一次（真含改动的）导出却免费。
-- ② 回填：上一版口径是「导出过就永久免费重导」，直接 DEFAULT true 会让所有存量项目
--    在没做任何改动的情况下重新开始收费——等于对老用户静默涨价。已成功导出过的置净。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "content_changed_at" timestamptz;

UPDATE "bid_projects" p SET "export_dirty" = false
WHERE EXISTS (
  SELECT 1 FROM "project_steps" s
  WHERE s."project_id" = p."id" AND s."step" = 'export' AND s."status" = 'done'
);
