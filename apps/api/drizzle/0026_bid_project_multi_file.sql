-- spec320：一个项目可挂多个招标文件（采购公告/主文件/技术规范书/附件…），读标合并解析全部文件。
-- tender_file_keys 存全部 key（数组）；tender_file_key 保留=第一个（向后兼容旧读侧/老数据）。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "tender_file_keys" jsonb;
