import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, projectFiles } from "../src/db/schema"
import { outlineReuseCandidates, reusableOutline } from "../src/services/outline-reuse"
import { loginWithPhone } from "../src/services/auth"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

/* 提纲沿用（2026-08-16 用户口径）：提纲可编辑，改好的那版应能被**同一份招标文件**的下个
   项目沿用。agent 那边的提纲缓存做不了这件事——它按文件字节全局共享，写进去等于把一个
   用户的私人编辑漏给所有人。所以沿用按用户取自他自己的历史项目，且必须显式选择。 */

let userId = ""
let otherUserId = ""
const P: Record<string, string> = {}

/** 建一条 tender 文件 + 一个用它的项目；outline 给了就落一条 done 的提纲步。 */
async function seed(opts: {
  who: string
  key: string
  filename: string
  size: number
  etag?: string | null
  name: string
  outline?: unknown
}) {
  const db = getDb()
  await db.insert(projectFiles).values({
    userId: opts.who,
    bucket: "bidsaas",
    key: opts.key,
    filename: opts.filename,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: opts.size,
    status: "uploaded",
    etag: opts.etag ?? null,
  })
  const [p] = await db
    .insert(bidProjects)
    .values({ userId: opts.who, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: opts.key, name: opts.name })
    .returning()
  if (opts.outline) {
    await db.insert(projectSteps).values({ projectId: p!.id, step: "outline", status: "done", result: opts.outline })
  }
  return p!.id
}

const OUTLINE_A = { chapters: [{ id: "b1", title: "我手改的响应函" }, { id: "t1", title: "技术方案" }] }

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  userId = r.user.id
  const r2 = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  otherUserId = r2.user.id
  // 同一份标书（同 etag/size）的历史项目：提纲已完成且被编辑过
  P.old = await seed({ who: userId, key: "u1/a.docx", filename: "云上江西.docx", size: 100, etag: "abc", name: "旧项目", outline: OUTLINE_A })
  // 本项目：同一份标书重新上传（key 不同、etag/size 相同）
  P.cur = await seed({ who: userId, key: "u1/b.docx", filename: "云上江西.docx", size: 100, etag: "abc", name: "本项目" })
  // 另一份标书（同名但大小不同）——绝不能被当成同一份
  P.other = await seed({ who: userId, key: "u1/c.docx", filename: "云上江西.docx", size: 999, etag: "zzz", name: "另一份标书", outline: OUTLINE_A })
  // 别人的同一份标书——绝不能跨用户串
  P.stranger = await seed({ who: otherUserId, key: "u2/a.docx", filename: "云上江西.docx", size: 100, etag: "abc", name: "别人的项目", outline: OUTLINE_A })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(users).where(eq(users.id, otherUserId))
  await closeDb()
})

describe("提纲沿用候选", () => {
  it("同一用户、同一份招标文件、提纲已完成 → 成为候选（重新上传导致 key 不同也认得出）", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId, "u1/b.docx")
    expect(list.map((c) => c.projectId)).toEqual([P.old!])
    expect(list[0]).toMatchObject({ name: "旧项目", chapterCount: 2 })
  })

  it("别人的项目绝不出现在候选里（缓存不能做这件事的原因就在这）", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId, "u1/b.docx")
    expect(list.some((c) => c.projectId === P.stranger)).toBe(false)
  })

  it("同名但内容不同（size/etag 不同）的标书不算同一份——沿用错标书比不给沿用糟得多", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId, "u1/b.docx")
    expect(list.some((c) => c.projectId === P.other)).toBe(false)
  })

  it("本项目自己不进候选", async () => {
    const list = await outlineReuseCandidates(P.old!, userId, "u1/a.docx")
    expect(list.some((c) => c.projectId === P.old)).toBe(false)
  })

  it("提纲取用要重新校验归属与同文件：请求体里塞别人的项目 id 取不到东西", async () => {
    expect(await reusableOutline(P.stranger!, P.cur!, userId, "u1/b.docx")).toBeNull()
    expect(await reusableOutline(P.other!, P.cur!, userId, "u1/b.docx")).toBeNull()
    const ok = await reusableOutline(P.old!, P.cur!, userId, "u1/b.docx")
    expect((ok as { chapters: unknown[] }).chapters).toHaveLength(2)
  })
})
