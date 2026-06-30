import { Hono } from "hono"
import type { AppDeps } from "../app"

const READY_CACHE_MS = 1000
const PING_TIMEOUT_MS = 2000

export function healthRoutes(deps: AppDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))

  // 就绪结果短缓存 + 超时：探针风暴下复用一次 select 1；DB 卡住时探针仍快速返回 down。
  let cached: { at: number; up: boolean } | undefined
  r.get("/readyz", async (c) => {
    const now = Date.now()
    if (!cached || now - cached.at > READY_CACHE_MS) {
      cached = { at: now, up: await pingWithTimeout(deps.pingDb, PING_TIMEOUT_MS) }
    }
    return cached.up
      ? c.json({ status: "ready", db: "up" })
      : c.json({ status: "unready", db: "down" }, 503)
  })
  return r
}

// pingDb 自身无超时；用 Promise.race 兜底，DB 半开/挂起时探针不会被拖住。
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
