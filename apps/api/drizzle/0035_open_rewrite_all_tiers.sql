-- 评审二轮 F3：改写全档开放（2026-07-28 产品口径）只改种子对既有环境无效——seedPlans 只插不更，
-- 已初始化环境（230 客户环境等）的 free/personal 行仍是旧种子的 rewrite:false，部署权益门禁后
-- 会把昨天还能用的付费改写一刀 403。本迁移把存量行回填为 true（幂等；企业模板 pptTemplate
-- 维持各档现值不动——那是有意的专业版专享）。
UPDATE plans
SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{rewrite}', 'true'::jsonb)
WHERE code IN ('free', 'personal');
