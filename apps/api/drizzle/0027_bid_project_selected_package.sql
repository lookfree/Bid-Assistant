-- spec324：多包件招标用户选投的包件（{id,name}），可空——单包标书/未选包时全链路行为不变。
ALTER TABLE "bid_projects" ADD COLUMN IF NOT EXISTS "selected_package" jsonb;
