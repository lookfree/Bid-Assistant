-- 并发防重：同一项目同一步同时只允许一行 running（双击/并发请求在 DB 层原子挡掉）
CREATE UNIQUE INDEX IF NOT EXISTS "project_steps_one_running" ON "project_steps" ("project_id", "step") WHERE status = 'running';
