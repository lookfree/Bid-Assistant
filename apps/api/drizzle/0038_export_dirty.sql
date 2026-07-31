-- 标书导出计费口径（2026-07-31 产品口径）：章节修改不收费，但内容改过之后的重新导出要收费。
-- 默认 true = 从未导出过的项目首次导出照收；成功导出后置 false，没改动就重复下载不再收费。
-- 用脏标记而非内容哈希：导出是每次点击的必经路径，哈希要把整本正文读出来算，
-- 与「导出路径不碰 result 列」的既有教训冲突（slim 教训）。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "export_dirty" boolean DEFAULT true NOT NULL;
