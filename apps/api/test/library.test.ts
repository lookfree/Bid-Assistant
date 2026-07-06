import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray, eq } from "drizzle-orm"
import { Hono } from "hono"
import { libraryRoutes } from "../src/routes/library"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

// /api/library 资料库 CRUD + 属主隔离（A 建的 B 读不到/改不到/删不到）
const app = new Hono()
app.route("/api/library", libraryRoutes())

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let fileA = "" // A 的已上传文件（POST 附件用）
let fileB = "" // B 的文件（验证挂他人文件被拒）
let fileDel = "" // A 的文件（验证删条目清附件）

type Item = {
  id: string
  userId: string
  category: string
  title: string
  meta: string | null
  fields: { label: string; value: string }[] | null
  expiry: string | null
  tags: string[] | null
  attachments: { fileId: string; name: string }[] | null
  body: string | null
}

// 直插 project_files 行（不真传 MinIO；删除清理对不存在对象的 DeleteObject 幂等成功）
async function insertFile(userId: string, filename: string): Promise<string> {
  const [row] = await getDb()
    .insert(projectFiles)
    .values({
      userId,
      bucket: "bidsaas",
      key: `uploads/${userId}/${crypto.randomUUID()}/${filename}`,
      filename,
      contentType: "application/pdf",
      size: 1,
      status: "uploaded",
    })
    .returning()
  return row!.id
}

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id
  fileA = await insertFile(userA, "iso27001.pdf")
  fileB = await insertFile(userB, "b-only.pdf")
  fileDel = await insertFile(userA, "to-delete.pdf")
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 条目/文件随 user 级联删
  await closeDb()
})

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })
const req = (path: string, token: string, init: RequestInit = {}) =>
  app.request(`/api/library${path}`, { ...init, headers: headers(token) })

describe("/api/library 资料库", () => {
  let itemId = ""

  it("POST 建条目 → 201 返回整行（camelCase）", async () => {
    const res = await req("", tokenA, {
      method: "POST",
      body: JSON.stringify({
        category: "qualification",
        title: "ISO27001 认证",
        meta: "证书编号 CN-2025-001",
        fields: [{ label: "发证机构", value: "CNAS" }],
        expiry: "2027-12-31",
        tags: ["体系认证"],
        attachments: [{ fileId: fileA, name: "iso27001.pdf" }],
        body: "证书说明正文",
      }),
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as Item
    expect(row.id).toBeTruthy()
    expect(row.userId).toBe(userA)
    expect(row.category).toBe("qualification")
    expect(row.title).toBe("ISO27001 认证")
    expect(row.fields).toEqual([{ label: "发证机构", value: "CNAS" }])
    expect(row.tags).toEqual(["体系认证"])
    expect(row.attachments?.[0]?.name).toBe("iso27001.pdf")
    itemId = row.id
  })

  it("非法 body（未知分类 / 空标题）→ 400", async () => {
    const bad1 = await req("", tokenA, { method: "POST", body: JSON.stringify({ category: "nope", title: "x" }) })
    expect(bad1.status).toBe(400)
    const bad2 = await req("", tokenA, { method: "POST", body: JSON.stringify({ category: "text", title: "" }) })
    expect(bad2.status).toBe(400)
  })

  it("attachments 挂不存在/他人的 fileId → 400 invalid_attachments", async () => {
    const ghost = await req("", tokenA, {
      method: "POST",
      body: JSON.stringify({
        category: "text",
        title: "幽灵附件",
        attachments: [{ fileId: crypto.randomUUID(), name: "ghost.pdf" }],
      }),
    })
    expect(ghost.status).toBe(400)
    expect(((await ghost.json()) as { error: string }).error).toBe("invalid_attachments")

    // 挂 B 的文件（越权引用）同样 400；PUT 同校验
    const theft = await req(`/${itemId}`, tokenA, {
      method: "PUT",
      body: JSON.stringify({ attachments: [{ fileId: fileB, name: "b-only.pdf" }] }),
    })
    expect(theft.status).toBe(400)
    expect(((await theft.json()) as { error: string }).error).toBe("invalid_attachments")
  })

  it("GET：A 能看到自己的条目，B 看不到（属主隔离）", async () => {
    const a = (await (await req("", tokenA)).json()) as { items: Item[] }
    expect(a.items.some((i) => i.id === itemId)).toBe(true)
    const b = (await (await req("", tokenB)).json()) as { items: Item[] }
    expect(b.items.some((i) => i.id === itemId)).toBe(false)
  })

  it("PUT：B 改 A 的条目 → 404 且未被改动；A 自己改 → 返回更新后整行", async () => {
    const byB = await req(`/${itemId}`, tokenB, { method: "PUT", body: JSON.stringify({ title: "被越权改名" }) })
    expect(byB.status).toBe(404)

    const byA = await req(`/${itemId}`, tokenA, {
      method: "PUT",
      body: JSON.stringify({ title: "ISO27001 信息安全认证", expiry: "长期有效" }),
    })
    expect(byA.status).toBe(200)
    const row = (await byA.json()) as Item
    expect(row.title).toBe("ISO27001 信息安全认证") // 未被 B 改动，且 A 的更新生效
    expect(row.expiry).toBe("长期有效")
    expect(row.meta).toBe("证书编号 CN-2025-001") // 未提交字段保持原值
  })

  it("PUT 清空语义：缺键=不改，null=清空（前端回传 fields:null 不再 400）", async () => {
    // UI 建条目常不带 fields → 后端返回 fields:null
    const created = await req("", tokenA, {
      method: "POST",
      body: JSON.stringify({ category: "text", title: "常用段落", meta: "一句话摘要" }),
    })
    expect(created.status).toBe(201)
    const item = (await created.json()) as Item
    expect(item.fields).toBeNull()

    // ① 前端编辑时把 fields:null 原样回传改 title → 200（此前 schema 拒绝 → 400 的实锤 bug）
    const echo = await req(`/${item.id}`, tokenA, {
      method: "PUT",
      body: JSON.stringify({ ...item, title: "常用段落 v2" }),
    })
    expect(echo.status).toBe(200)
    expect(((await echo.json()) as Item).title).toBe("常用段落 v2")

    // ② 显式 meta:null → 清空落库
    const cleared = await req(`/${item.id}`, tokenA, { method: "PUT", body: JSON.stringify({ meta: null }) })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as Item).meta).toBeNull()

    // ③ 缺 meta 键 → meta 保留旧值（先写回一个值再验证）
    await req(`/${item.id}`, tokenA, { method: "PUT", body: JSON.stringify({ meta: "重新填的摘要" }) })
    const untouched = await req(`/${item.id}`, tokenA, { method: "PUT", body: JSON.stringify({ title: "只改标题" }) })
    expect(untouched.status).toBe(200)
    const row = (await untouched.json()) as Item
    expect(row.title).toBe("只改标题")
    expect(row.meta).toBe("重新填的摘要")
  })

  it("DELETE 带附件条目 → 200 且 project_files 行被清理（best-effort）", async () => {
    const created = await req("", tokenA, {
      method: "POST",
      body: JSON.stringify({
        category: "performance",
        title: "待删业绩",
        attachments: [{ fileId: fileDel, name: "to-delete.pdf" }],
      }),
    })
    expect(created.status).toBe(201)
    const item = (await created.json()) as Item

    const del = await req(`/${item.id}`, tokenA, { method: "DELETE" })
    expect(del.status).toBe(200)
    // 附件与条目 1:1，删条目顺带清 project_files 行（MinIO 对象删除幂等，不需真实对象）
    const rows = await getDb().select().from(projectFiles).where(eq(projectFiles.id, fileDel))
    expect(rows.length).toBe(0)
  })

  it("DELETE：B 删 A 的条目 → 404；A 自己删 → {ok:true} 且列表消失", async () => {
    const byB = await req(`/${itemId}`, tokenB, { method: "DELETE" })
    expect(byB.status).toBe(404)

    const byA = await req(`/${itemId}`, tokenA, { method: "DELETE" })
    expect(byA.status).toBe(200)
    expect(((await byA.json()) as { ok: boolean }).ok).toBe(true)

    const list = (await (await req("", tokenA)).json()) as { items: Item[] }
    expect(list.items.some((i) => i.id === itemId)).toBe(false)
  })

  it("不存在/非 uuid 的 id → 404；未登录 → 401", async () => {
    const gone = await req(`/${crypto.randomUUID()}`, tokenA, { method: "DELETE" })
    expect(gone.status).toBe(404)
    const badId = await req("/not-a-uuid", tokenA, { method: "PUT", body: JSON.stringify({ title: "x" }) })
    expect(badId.status).toBe(404)
    const anon = await app.request("/api/library")
    expect(anon.status).toBe(401)
  })
})
