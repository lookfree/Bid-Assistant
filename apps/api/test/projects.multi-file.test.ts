import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// POST /api/projects 多文件建项目（spec320）：fileKeys 属主校验 + 两列落库；旧 fileKey 单文件不回归。
const app = new Hono()
app.route("/api/projects", projectRoutes())

let tokenA = ""
let userA = ""
let userB = ""
let keyA1 = ""
let keyA2 = ""
let keyB = ""
let keyMessy = ""   // key 的 basename 被 sanitize 过，与真实文件名**不同**

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  userB = b.user.id

  keyA1 = `uploads/${userA}/${crypto.randomUUID()}/公告.pdf`
  keyA2 = `uploads/${userA}/${crypto.randomUUID()}/技术规范书.docx`
  keyB = `uploads/${userB}/${crypto.randomUUID()}/b.pdf`
  // 上传链路会 sanitize 文件名进 key（空格/括号 → 下划线）：只有真去库里查 filename 才拿得到原名
  keyMessy = `uploads/${userA}/${crypto.randomUUID()}/_______2______-____ _____.doc`
  await getDb().insert(projectFiles).values([
    { userId: userA, bucket: "bidsaas", key: keyA1, filename: "公告.pdf", contentType: "application/pdf", size: 1, status: "uploaded" },
    { userId: userA, bucket: "bidsaas", key: keyA2, filename: "技术规范书.docx", contentType: "application/msword", size: 1, status: "uploaded" },
    { userId: userB, bucket: "bidsaas", key: keyB, filename: "b.pdf", contentType: "application/pdf", size: 1, status: "uploaded" },
    { userId: userA, bucket: "bidsaas", key: keyMessy, filename: "银联数据统一身份认证系统采购项目（第二次）-采购文件 （发售稿）.doc", contentType: "application/msword", size: 1, status: "uploaded" },
  ])
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件随 user 级联删
  await closeDb()
})

const post = (body: unknown, token = tokenA) =>
  app.request("/api/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("POST /api/projects 多文件（spec320）", () => {
  it("fileKeys 多文件：两列落库，name 取首个文件的原始 filename", async () => {
    const res = await post({ fileKeys: [keyA1, keyA2] })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(p?.tenderFileKey).toBe(keyA1)
    expect(p?.tenderFileKeys).toEqual([keyA1, keyA2])
    expect(p?.name).toBe("公告.pdf")
  })

  it("fileKeys 混入他人 key → 400 invalid_files，不留项目行", async () => {
    const before = (await getDb().select().from(bidProjects).where(eq(bidProjects.userId, userA))).length
    const res = await post({ fileKeys: [keyA1, keyB] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_files")
    const after = (await getDb().select().from(bidProjects).where(eq(bidProjects.userId, userA))).length
    expect(after).toBe(before) // 未插入半属主的项目行
  })

  it("fileKeys 含不存在的 key → 400 invalid_files", async () => {
    const res = await post({ fileKeys: [keyA1, `uploads/${userA}/${crypto.randomUUID()}/ghost.pdf`] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_files")
  })

  it("超过 10 个 fileKeys → 400 invalid_input（zod 上限）", async () => {
    const res = await post({ fileKeys: Array.from({ length: 11 }, () => keyA1) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_input")
  })

  it("旧 fileKey 单文件仍可用（不回归）：tenderFileKeys 落一元素数组", async () => {
    const res = await post({ fileKey: keyA1 })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(p?.tenderFileKey).toBe(keyA1)
    expect(p?.tenderFileKeys).toEqual([keyA1])
  })

  it("旧 fileKey 指向他人的 key → 400 invalid_files", async () => {
    const res = await post({ fileKey: keyB })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_files")
  })

  it("空 body → 400 invalid_input", async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_input")
  })
})

describe("GET /api/projects 文件构成（2026-08-12）", () => {
  it("列表回招标/投标各自的**原始文件名**，不是 MinIO key", async () => {
    const res = await post({ fileKeys: [keyA1, keyA2] })
    const { id } = (await res.json()) as { id: string }
    const list = await app.request("/api/projects?pageSize=50", {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    const { items } = (await list.json()) as { items: { id: string; tenderFiles: string[]; bidFiles: string[] }[] }
    const row = items.find((i) => i.id === id)
    // 一份招标常是正文+补遗+答疑：卡片过去只渲染一个派生项目名，用户看不出自己传了几份
    expect(row?.tenderFiles).toEqual(["公告.pdf", "技术规范书.docx"])
    expect(row?.bidFiles).toEqual([]) // 生成项目的投标文件是系统写的，不在这里
  })

  it("回的是库里的原始文件名，不是 key 里 sanitize 过的 basename", async () => {
    const res = await post({ fileKeys: [keyMessy] })
    const { id } = (await res.json()) as { id: string }
    const list = await app.request("/api/projects?pageSize=50", {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    const { items } = (await list.json()) as { items: { id: string; tenderFiles: string[] }[] }
    // key 里是「_______2______-____ _____.doc」，拿它当名字展示等于给用户看一串下划线
    expect(items.find((i) => i.id === id)?.tenderFiles).toEqual([
      "银联数据统一身份认证系统采购项目（第二次）-采购文件 （发售稿）.doc",
    ])
  })

  it("线下审查项目回投标文件名（多份分册照序给全）", async () => {
    const res = await app.request("/api/projects/review", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ bidFileKeys: [keyA2, keyA1], tenderFileKeys: [keyA1] }),
    })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const list = await app.request("/api/projects?pageSize=50", {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    const { items } = (await list.json()) as { items: { id: string; tenderFiles: string[]; bidFiles: string[] }[] }
    const row = items.find((i) => i.id === id)
    expect(row?.bidFiles).toEqual(["技术规范书.docx", "公告.pdf"]) // 顺序=拼接顺序，不许排序
    expect(row?.tenderFiles).toEqual(["公告.pdf"])
  })
})
