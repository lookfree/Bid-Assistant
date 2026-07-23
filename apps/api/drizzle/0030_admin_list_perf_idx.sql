-- spec331 后台列表性能：订单/审计日志默认按 created_at desc 分页,补对应降序索引（数据量增长后避免全表 filesort）
CREATE INDEX IF NOT EXISTS "payment_orders_created_idx" ON "payment_orders" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_idx" ON "admin_audit_logs" ("created_at" DESC);
