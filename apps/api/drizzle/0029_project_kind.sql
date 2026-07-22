-- spec328 独立审查模块：项目类型（bid=生成流水线,review=审查专用）+ 线下标书文件 key
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'bid';
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "bid_file_key" text;
