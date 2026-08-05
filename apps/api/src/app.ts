import { Hono } from "hono"
import { cors } from "hono/cors"
import { healthRoutes } from "./routes/health"
import { authRoutes } from "./routes/auth"
import { wechatRoutes } from "./routes/wechat"
import { publicRoutes } from "./routes/public"
import { fileRoutes } from "./routes/files"
import { readRoutes } from "./routes/read"
import { projectRoutes } from "./routes/projects"
import { paymentRoutes } from "./routes/payment"
import { membershipRoutes } from "./routes/membership"
import { referralRoutes } from "./routes/referral"
import { creditsRoutes } from "./routes/credits"
import { ordersRoutes } from "./routes/orders"
import { libraryRoutes } from "./routes/library"
import { checklistRoutes } from "./routes/checklist"
import { dedupeRoutes } from "./routes/dedupe"
import { feedbackRoutes } from "./routes/feedback"
import { invoiceRoutes } from "./routes/invoices"
import { adminRoutes } from "./routes/admin"
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
  // JSON 响应显式带 charset=utf-8（spec331 加固）：Hono c.json() 默认不带 charset,严格/老式客户端
  // （PowerShell、部分 curl 终端）会按本地编码解 UTF-8 → 中文 mojibake。补上后中文体字节不变、防误判。
  app.use("*", async (c, next) => {
    await next()
    const ct = c.res.headers.get("content-type")
    if (ct === "application/json") c.res.headers.set("content-type", "application/json; charset=utf-8")
    // 禁止缓存（2026-08-05 安全测试报告项「敏感接口未禁止缓存」）：接口回的都是鉴权后的
    // 用户/运营数据，不该被浏览器或中间代理留存。Pragma 是给只认 HTTP/1.0 的老代理的。
    // 在 API 层而非 nginx：随代码走、有测试兜底，也不受服务器上手改配置的漂移影响。
    c.res.headers.set("cache-control", "no-store, no-cache, must-revalidate")
    c.res.headers.set("pragma", "no-cache")
  })
  // 跨域：白名单数组交给 hono/cors 匹配——命中回显该 Origin，未命中不发 ACAO（不回显任意来源）。env 由 index.ts 注入。
  const allow = deps.webOrigins?.length ? deps.webOrigins : ["http://localhost:3000", "http://localhost:3001"]
  app.use(
    "*",
    cors({
      origin: allow,
      // 必须列全 API 实际服务的方法：跨域部署（web 走 api.localhost）下，浏览器对 PATCH/DELETE 先发 CORS
      // 预检，方法不在此列表 → 预检失败 → 浏览器拦截真实请求（curl 不走预检，故只在浏览器暴露）。
      // PATCH：/steps/:step 编辑回写；PUT：/checklist upsert（spec315b）；DELETE：/library/:id。
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
        sessionTtlDays: deps.sessionTtlDays ?? 7,
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
  app.route("/api/public", publicRoutes()) // 公开展示配置（免鉴权，只出注册赠送积分等可公开值）
  app.route("/files", fileRoutes()) // 自带 authMiddleware，无需额外 deps
  app.route("/api/read", readRoutes()) // 读标编排（预扣→建run→SSE中继→存结果→settle），自带 authMiddleware
  app.route("/api/projects", projectRoutes()) // 全流程按步编排（spec207），自带 authMiddleware
  app.route("/api/payment", paymentRoutes()) // 收钱吧支付（spec304）；notify 验签放行，其余自带 authMiddleware
  app.route("/api/membership", membershipRoutes()) // 会员续费（spec305）；自带 authMiddleware
  app.route("/api/referral", referralRoutes()) // 推荐奖励（spec307）；自带 authMiddleware
  app.route("/api/credits", creditsRoutes()) // 积分流水分页（spec308）；自带 authMiddleware
  app.route("/api/orders", ordersRoutes()) // 我的订单分页（spec308）；自带 authMiddleware
  app.route("/api/library", libraryRoutes()) // 个人资料库 CRUD；自带 authMiddleware
  app.route("/api/checklist", checklistRoutes()) // 终极审核表持久化+导出（spec315b）；自带 authMiddleware
  app.route("/api/dedupe", dedupeRoutes()) // 标书查重计费编排（spec315b）；自带 authMiddleware
  app.route("/api/feedback", feedbackRoutes()) // 反馈/投诉（spec326）；money-blind，自带 authMiddleware
  app.route("/api/invoices", invoiceRoutes()) // 发票申请（spec332）；money-blind，自带 authMiddleware
  app.route("/admin-api", adminRoutes()) // 运营后台（spec309）；独立 admin 身份/RBAC，与 C 端完全隔离
  return app
}
