-- spec333 定制审核表：project_checklists 增可空 template 列（读标结论生成的分组条目定义）。
-- 幂等：IF NOT EXISTS。null = 前端回落默认 36 条静态表。
ALTER TABLE "project_checklists" ADD COLUMN IF NOT EXISTS "template" jsonb;
