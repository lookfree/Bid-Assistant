import { describe, it, expect } from "bun:test"
import { createApp } from "../src/app"

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("spec331：JSON 响应带 charset=utf-8（防客户端按本地编码解 UTF-8 → 中文乱码）", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/healthz")
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
  })
})

describe("CORS 预检覆盖 API 实际方法（跨域部署 web→api.localhost）", () => {
  // 回归:allowMethods 曾漏 PATCH/DELETE → 浏览器跨域预检失败 → 保存提纲(PATCH)/删资料(DELETE)被拦。
  it.each(["PATCH", "DELETE", "PUT", "POST"])("OPTIONS 预检放行 %s", async (method) => {
    const app = createApp({ pingDb: async () => true, webOrigins: ["http://app.localhost"] })
    const res = await app.request("/api/projects/x/steps/outline", {
      method: "OPTIONS",
      headers: {
        Origin: "http://app.localhost",
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain(method)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://app.localhost")
  })
})

describe("GET /readyz", () => {
  it("returns 200 when db reachable", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/readyz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ready", db: "up" })
  })
  it("returns 503 when db unreachable", async () => {
    const app = createApp({ pingDb: async () => false })
    const res = await app.request("/readyz")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "unready", db: "down" })
  })
})
