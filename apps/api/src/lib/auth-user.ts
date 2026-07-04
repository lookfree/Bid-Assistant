import type { Context } from "hono"

// 统一取当前用户 ID：authMiddleware 全链路设 c.set("user", user)（各路由一致），
// 这里集中读取并对缺失兜底抛错（路由层转 401），避免各处散写 c.get("user").id。
export function getUserId(c: Context): string {
  const user = c.get("user") as { id?: string } | undefined
  if (user?.id) return user.id
  throw new Error("unauthorized")
}
