import { Hono } from "hono"

export type HealthDeps = { pingDb: () => Promise<boolean> }

export function healthRoutes(deps: HealthDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))
  return r
}
