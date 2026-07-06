-- 项目名列：建项时取 project_files.filename（上传原始文件名）落库；
-- 列表不再从 tender_file_key 反解（key 里是 sanitize 后的名，decodeURIComponent 前提不成立）。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "name" text;
