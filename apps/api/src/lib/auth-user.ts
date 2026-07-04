import type { Context } from "hono"

// 统一取当前用户 ID：屏蔽历史鉴权字段不一致（spec004 设 c.set("user", user)，
// spec207/304/305 用 c.get("userId")）。优先 userId，回落 user.id；都没有抛错（路由层转 401）。
export function getUserId(c: Context): string {
  const direct = c.get("userId") as string | undefined
  if (direct) return direct
  const user = c.get("user") as { id?: string } | undefined
  if (user?.id) return user.id
  throw new Error("unauthorized")
}
