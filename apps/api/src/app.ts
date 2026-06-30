import { Hono } from "hono"
import { healthRoutes } from "./routes/health"
import { authRoutes } from "./routes/auth"
import type { SmsCodeService } from "./services/sms-code"

export type AppDeps = {
  pingDb: () => Promise<boolean>
  smsCode?: SmsCodeService
  sessionTtlDays?: number
  captchaEnabled?: boolean
  verifyCaptcha?: (token?: string) => Promise<boolean>
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.route("/", healthRoutes(deps))
  if (deps.smsCode) {
    app.route(
      "/auth",
      authRoutes({
        smsCode: deps.smsCode,
        sessionTtlDays: deps.sessionTtlDays ?? 30,
        captchaEnabled: deps.captchaEnabled ?? false,
        verifyCaptcha: deps.verifyCaptcha ?? (async () => true),
      }),
    )
  }
  return app
}
