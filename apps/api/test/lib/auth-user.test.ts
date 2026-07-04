import { describe, it, expect } from "bun:test"
import { Hono } from "hono"
import { getUserId } from "../../src/lib/auth-user"

// 用最小 Hono app 注入变量后调 getUserId，覆盖两种历史鉴权写法 + 缺失。
function appThatSets(setter: (c: any) => void) {
  const app = new Hono()
  app.get("/", (c) => {
    setter(c)
    try {
      return c.json({ id: getUserId(c) })
    } catch {
      return c.json({ error: "unauthorized" }, 401)
    }
  })
  return app
}

describe("spec308 getUserId", () => {
  it("读 c.get('user').id", async () => {
    const app = appThatSets((c) => c.set("user", { id: "u-2" }))
    expect(await (await app.request("/")).json()).toEqual({ id: "u-2" })
  })

  it("user 缺失 → 抛错，路由转 401", async () => {
    const app = appThatSets(() => {})
    expect((await app.request("/")).status).toBe(401)
  })
})
