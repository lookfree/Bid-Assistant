-- 运营备注（后台专用）：微信/手机注册的用户常无昵称，后台列表只能显示"未命名用户"，
-- 运营需要能标注"这是谁"。可空、无默认，存量行不受影响；C 端接口不返回该列。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_note" text;
