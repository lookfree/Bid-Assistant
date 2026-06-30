import { Hono } from "hono"
import { healthRoutes } from "./routes/health"

export type AppDeps = { pingDb: () => Promise<boolean> }

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.route("/", healthRoutes(deps))
  return app
}
