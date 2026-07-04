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

describe("spec308 getUserId 兼容两种鉴权写法", () => {
  it("c.get('userId') 优先", async () => {
    const app = appThatSets((c) => c.set("userId", "u-1"))
    expect(await (await app.request("/")).json()).toEqual({ id: "u-1" })
  })

  it("回落 c.get('user').id", async () => {
    const app = appThatSets((c) => c.set("user", { id: "u-2" }))
    expect(await (await app.request("/")).json()).toEqual({ id: "u-2" })
  })

  it("userId 存在时不被 user 覆盖", async () => {
    const app = appThatSets((c) => {
      c.set("user", { id: "u-user" })
      c.set("userId", "u-direct")
    })
    expect(await (await app.request("/")).json()).toEqual({ id: "u-direct" })
  })

  it("都没有 → 抛错，路由转 401", async () => {
    const app = appThatSets(() => {})
    expect((await app.request("/")).status).toBe(401)
  })
})
