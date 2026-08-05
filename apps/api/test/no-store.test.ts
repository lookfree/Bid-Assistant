import { describe, it, expect } from "bun:test"
import { createApp } from "../src/app"

// 2026-08-05 安全测试报告项「敏感接口未禁止缓存」：管理/业务接口此前不回 Cache-Control 与 Pragma，
// 响应可能被浏览器或中间代理留存。接口回的都是鉴权后的用户/运营数据，一律不缓存。
// 放在 API 层而不是 nginx：代码在仓库里、能写测试，也不受服务器上手改配置的漂移影响。
describe("接口响应禁止缓存", () => {
  const app = () => createApp({ pingDb: async () => true })

  it.each([
    ["/healthz", "健康检查"],
    ["/admin-api/overview", "管理接口（未登录，401 也不该被缓存）"],
    ["/api/projects", "业务接口"],
    ["/api/public/signup-grant", "公开配置接口"],
  ])("%s 回 no-store + Pragma（%s）", async (path) => {
    const res = await app().request(path)
    expect(res.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate")
    expect(res.headers.get("pragma")).toBe("no-cache")
  })

  it("404 也带上——不存在的路径同样不该被中间代理留存", async () => {
    const res = await app().request("/does-not-exist")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate")
  })
})
