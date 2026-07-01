import { Hono } from "hono"
import { cors } from "hono/cors"
import { healthRoutes } from "./routes/health"
import { authRoutes } from "./routes/auth"
import { wechatRoutes } from "./routes/wechat"
import type { SmsCodeService } from "./services/sms-code"
import type { makeWechatAuth } from "./services/wechat-auth"

export type AppDeps = {
  pingDb: () => Promise<boolean>
  smsCode?: SmsCodeService
  sessionTtlDays?: number
  captchaEnabled?: boolean
  verifyCaptcha?: (token?: string) => Promise<boolean>
  webOrigins?: string[]
  wechat?: { service: ReturnType<typeof makeWechatAuth>; appId: string; redirectUri: string }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  // 跨域：白名单数组交给 hono/cors 匹配——命中回显该 Origin，未命中不发 ACAO（不回显任意来源）。env 由 index.ts 注入。
  const allow = deps.webOrigins?.length ? deps.webOrigins : ["http://localhost:3000", "http://localhost:3001"]
  app.use(
    "*",
    cors({
      origin: allow,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
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
  if (deps.wechat) {
    app.route(
      "/auth/wechat",
      wechatRoutes({
        wechat: deps.wechat.service,
        appId: deps.wechat.appId,
        redirectUri: deps.wechat.redirectUri,
      }),
    )
  }
  return app
}
