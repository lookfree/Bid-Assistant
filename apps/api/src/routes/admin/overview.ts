import { Hono } from "hono"
import { computeOverview } from "../../services/admin/overview"

// 概览页（spec310）：只读，requireAdmin 已在聚合层套，任意角色可读。
export const overviewRouter = new Hono()
overviewRouter.get("/", async (c) => c.json(await computeOverview()))
