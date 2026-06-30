import { Hono } from "hono"

export type HealthDeps = { pingDb: () => Promise<boolean> }

export function healthRoutes(deps: HealthDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))
  r.get("/readyz", async (c) => {
    const up = await deps.pingDb().catch(() => false)
    return up
      ? c.json({ status: "ready", db: "up" })
      : c.json({ status: "unready", db: "down" }, 503)
  })
  return r
}
