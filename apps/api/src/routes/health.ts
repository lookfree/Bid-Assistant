import { Hono } from "hono"
import type { AppDeps } from "../app"

const PING_TIMEOUT_MS = 2000

export function healthRoutes(deps: AppDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))
  r.get("/readyz", async (c) => {
    const up = await pingWithTimeout(deps.pingDb, PING_TIMEOUT_MS)
    return up
      ? c.json({ status: "ready", db: "up" })
      : c.json({ status: "unready", db: "down" }, 503)
  })
  return r
}

// pingDb 自身无超时；用 Promise.race 兜底，DB 半开/挂起时探针仍快速返回 down。
async function pingWithTimeout(ping: () => Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([ping().catch(() => false), timeout])
  } finally {
    clearTimeout(timer)
  }
}
