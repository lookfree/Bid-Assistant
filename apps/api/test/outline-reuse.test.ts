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
   用户的私人编辑漏给所有人。所以沿用按用户取自他自己的历史项目，且必须显式选择。

   评审 2026-08-16 追加的边界：包件必须相同（F1）、多文件按整集合比对（F4）、
   列出的行与取用的行必须是同一条且非空（F3）。 */

let userId = ""
let otherUserId = ""
const P: Record<string, string> = {}

async function addFile(who: string, key: string, filename: string, size: number, etag: string | null) {
  await getDb().insert(projectFiles).values({
    userId: who,
    bucket: "bidsaas",
    key,
    filename,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size,
    status: "uploaded",
    etag,
  })
}

/** 建项目（可多文件、可带包件）；outline 给了就落一条 done 的提纲步。 */
async function seed(opts: {
  who: string
  files: Array<[key: string, filename: string, size: number, etag: string | null]>
  name: string
  pkg?: { id: string; name: string }
  outline?: unknown
}) {
  for (const [key, filename, size, etag] of opts.files) await addFile(opts.who, key, filename, size, etag)
  const keys = opts.files.map(([k]) => k)
  const [p] = await getDb()
    .insert(bidProjects)
    .values({
      userId: opts.who,
      threadId: `proj-${crypto.randomUUID()}`,
      tenderFileKey: keys[0],
      tenderFileKeys: keys,
      name: opts.name,
      selectedPackage: opts.pkg ?? null,
    })
    .returning()
  if (opts.outline) {
    await getDb().insert(projectSteps).values({ projectId: p!.id, step: "outline", status: "done", result: opts.outline })
  }
  return p!.id
}

const OUTLINE_A = { chapters: [{ id: "b1", title: "我手改的响应函" }, { id: "t1", title: "技术方案" }] }
const MAIN: [string, string, number, string | null] = ["u1/a.docx", "云上江西.docx", 100, "abc"]

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  userId = r.user.id
  const r2 = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  otherUserId = r2.user.id
  P.old = await seed({ who: userId, files: [MAIN], name: "旧项目", outline: OUTLINE_A })
  // 本项目：同一份标书重新上传（key 不同、etag/size 相同）
  P.cur = await seed({ who: userId, files: [["u1/b.docx", "云上江西.docx", 100, "abc"]], name: "本项目" })
  // 另一份标书（同名但大小不同）
  P.other = await seed({ who: userId, files: [["u1/c.docx", "云上江西.docx", 999, "zzz"]], name: "另一份标书", outline: OUTLINE_A })
  // 别人的同一份标书
  P.stranger = await seed({ who: otherUserId, files: [["u2/a.docx", "云上江西.docx", 100, "abc"]], name: "别人的", outline: OUTLINE_A })
  // 同一份主文件、但投的是另一个包件（spec324 的「投另一个包=另建项目」）
  P.pkgB = await seed({
    who: userId,
    files: [["u1/d.docx", "云上江西.docx", 100, "abc"]],
    name: "B 包项目",
    pkg: { id: "p2", name: "B 包" },
    outline: OUTLINE_A,
  })
  // 同一主文件 + 多带一份技术规范书（spec320 多文件）——不是同一份标书
  P.multi = await seed({
    who: userId,
    files: [
      ["u1/e.docx", "云上江西.docx", 100, "abc"],
      ["u1/e2.docx", "技术规范书.docx", 200, "spec"],
    ],
    name: "多文件项目",
    outline: OUTLINE_A,
  })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(users).where(eq(users.id, otherUserId))
  await closeDb()
})

describe("提纲沿用候选", () => {
  it("同一用户、同一份招标文件、提纲已完成 → 成为候选（重新上传导致 key 不同也认得出）", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.map((c) => c.projectId)).toEqual([P.old!])
    expect(list[0]).toMatchObject({ name: "旧项目", chapterCount: 2, packageName: null })
  })

  it("别人的项目绝不出现在候选里（缓存不能做这件事的原因就在这）", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.some((c) => c.projectId === P.stranger)).toBe(false)
  })

  it("同名但内容不同（size/etag 不同）的标书不算同一份", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.some((c) => c.projectId === P.other)).toBe(false)
  })

  it("评审 F1：另一个包件的兄弟项目不得沿用——B 包缺 B 包独有的必备构成项就是废标", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.some((c) => c.projectId === P.pkgB)).toBe(false)
    const forB = await outlineReuseCandidates(P.pkgB!, userId) // 反向：未选包的项目对 B 包也不算数
    expect(forB.some((c) => c.projectId === P.old)).toBe(false)
  })

  it("评审 F4：多文件按整集合比对——只比首个文件会把「主文件+技术规范书」判成同一份", async () => {
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.some((c) => c.projectId === P.multi)).toBe(false)
  })

  it("本项目自己不进候选", async () => {
    const list = await outlineReuseCandidates(P.old!, userId)
    expect(list.some((c) => c.projectId === P.old)).toBe(false)
  })

  it("提纲取用要重新校验归属/同文件/同包件：请求体里塞别的项目 id 取不到东西", async () => {
    expect(await reusableOutline(P.stranger!, P.cur!, userId)).toBeNull()
    expect(await reusableOutline(P.other!, P.cur!, userId)).toBeNull()
    expect(await reusableOutline(P.pkgB!, P.cur!, userId)).toBeNull()
    const ok = await reusableOutline(P.old!, P.cur!, userId)
    expect((ok as { chapters: unknown[] }).chapters).toHaveLength(2)
  })

  it("评审 F3：空 chapters 的提纲步不算可沿用——否则 0 预扣放行一次完整生成", async () => {
    const empty = await seed({
      who: userId,
      files: [["u1/f.docx", "空提纲.docx", 55, "empty"]],
      name: "空提纲项目",
      outline: { chapters: [] },
    })
    const sameFile = await seed({ who: userId, files: [["u1/f2.docx", "空提纲.docx", 55, "empty"]], name: "同文件新项目" })
    expect(await outlineReuseCandidates(sameFile, userId)).toHaveLength(0)
    expect(await reusableOutline(empty, sameFile, userId)).toBeNull()
  })

  it("评审 F3：列出的章数与取用的提纲来自**同一行**（同项目多条 done 提纲取最新）", async () => {
    await getDb()
      .insert(projectSteps)
      .values({ projectId: P.old!, step: "outline", status: "done", result: { chapters: [{ id: "x", title: "最新那版" }] } })
    const list = await outlineReuseCandidates(P.cur!, userId)
    expect(list.find((c) => c.projectId === P.old)?.chapterCount).toBe(1)
    const got = (await reusableOutline(P.old!, P.cur!, userId)) as { chapters: Array<{ title: string }> }
    expect(got.chapters).toHaveLength(1)
    expect(got.chapters[0]!.title).toBe("最新那版")
  })
})
