/**
 * GET /api/projects/:id/bid-chapters（#97②）：审查报告点「定位到标书原文」时按需分章。
 *
 * agent 调用走 deps 注入（同 renderDeck/rewriteChapter 的手法）——不用 mock.module：
 * 那是进程级全局替换模块表，同进程全量跑时会泄漏给 agent-client 的其它测试文件。
 */
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects } from "../src/db/schema"
import { loginWithPhone } from "../src/services/auth"
import { projectRoutes } from "../src/routes/projects"
import { AgentHttpError } from "../src/services/agent-client"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

const CHAPTERS = { chapters: [{ sec: "sec-2", title: "第二章 技术方案", paragraphs: ["零信任网关部署方案……"] }], truncated: false }

let calls: string[][] = []
const app = new Hono()
app.route("/api/projects", projectRoutes({
  bidChapters: async (keys: string[]) => {
    calls.push(keys)
    if (keys.some((k) => k.includes("bad"))) throw new AgentHttpError(422, { error: "parse_failed" })
    if (keys.some((k) => k.includes("down"))) throw new AgentHttpError(500, {})
    return CHAPTERS
  },
}))

let token = ""
let userId = ""
let otherId = ""

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  token = a.token
  userId = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  otherId = b.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userId, otherId]))
  await closeDb()
})

async function makeProject(owner: string, bidKeys: string[] | null): Promise<string> {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({
      userId: owner,
      threadId: `t-${crypto.randomUUID()}`,
      kind: "review",
      name: "线下标书",
      ...(bidKeys ? { bidFileKey: bidKeys[0], bidFileKeys: bidKeys } : {}),
    })
    .returning()
  return p!.id
}

const get = (id: string, tk = token) =>
  app.request(`/api/projects/${id}/bid-chapters`, { headers: { Authorization: `Bearer ${tk}` } })

describe("GET /:id/bid-chapters", () => {
  it("有线下投标文件 → 回分章正文，全部 key 都送去解析（分册出卷是常态）", async () => {
    calls = []
    const id = await makeProject(userId, ["uploads/a/商务标.docx", "uploads/a/技术标.docx"])
    const res = await get(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(CHAPTERS)
    expect(calls[0]).toEqual(["uploads/a/商务标.docx", "uploads/a/技术标.docx"])
  })

  it("没有线下投标文件 → 409，不是 404", async () => {
    // 系统生成的标书正文在正文页，不走这条路。前端据此不渲染入口；
    // 回 404 会被当成「项目不存在」，用户以为标书丢了。
    const id = await makeProject(userId, null)
    const res = await get(id)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_bid_file")
  })

  it("别人的项目 → 404（不泄漏存在性）", async () => {
    const id = await makeProject(otherId, ["uploads/b/x.docx"])
    expect((await get(id)).status).toBe(404)
  })

  it("解析不出（加密/损坏/纯扫描件）→ 422 透传，不当成服务故障", async () => {
    // 前端据此说「这份标书给不出可跳转的正文」，而不是弹「稍后再试」让人白点
    const id = await makeProject(userId, ["uploads/a/bad.pdf"])
    const res = await get(id)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toBe("unparsable")
  })

  it("agent 挂了 → 502", async () => {
    const id = await makeProject(userId, ["uploads/a/down.docx"])
    expect((await get(id)).status).toBe(502)
  })

  it("非法 id → 404", async () => {
    expect((await get("not-a-uuid")).status).toBe(404)
  })
})
