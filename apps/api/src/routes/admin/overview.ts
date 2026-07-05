import { Hono } from "hono"
import { computeOverview, computeTrend } from "../../services/admin/overview"

// 概览页（spec310）：只读，requireAdmin 已在聚合层套，任意角色可读。
export const overviewRouter = new Hono()
overviewRouter.get("/", async (c) => c.json(await computeOverview()))
// 趋势时序（spec313）：近 N 天每日营收/积分；days 限 1..90。
overviewRouter.get("/trend", async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 14))
  return c.json(await computeTrend(days))
})
