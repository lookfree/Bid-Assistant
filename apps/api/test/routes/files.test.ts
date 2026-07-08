import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createApp } from "../../src/app"
import { loginWithPhone } from "../../src/services/auth"
import { getDb, closeDb } from "../../src/db/client"
import { users, projectFiles } from "../../src/db/schema"
import { deleteObject } from "../../src/storage/s3"
import { uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB + MinIO

const app = createApp({ pingDb: async () => true })
let token = ""
let userId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
})
afterAll(async () => {
  const rows = await getDb().select().from(projectFiles).where(eq(projectFiles.userId, userId))
  for (const r of rows) await deleteObject(r.key).catch(() => {})
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

describe("/files", () => {
  it("未鉴权 -> 401", async () => {
    const res = await app.request("/files/presign-upload", { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })

  it("presign(.docx 白名单放行) -> PUT -> complete -> download-url 全链路", async () => {
    const body = "tender-bytes"
    // 文件名须过 SUPPORTED_EXTS 白名单（pdf/docx/xlsx）；内容字节 MinIO 不校验，用文本即可
    const pre = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "t.docx", contentType: "text/plain", size: body.length }),
    })
    expect(pre.status).toBe(200)
    const { fileId, uploadUrl } = (await pre.json()) as { fileId: string; uploadUrl: string }
    await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body })

    const done = await app.request(`/files/${fileId}/complete`, { method: "POST", headers: auth() })
    expect(done.status).toBe(200)
    expect(((await done.json()) as { file: { status: string } }).file.status).toBe("uploaded")

    const dl = await app.request(`/files/${fileId}/download-url`, { headers: auth() })
    const { url } = (await dl.json()) as { url: string }
    expect(await (await fetch(url)).text()).toBe(body)
  })

  it("扩展名白名单：.doc 老格式 → 400 unsupported_file_type（解析层必败，入口 fail fast）", async () => {
    const res = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "老标书.doc", contentType: "application/msword", size: 10 }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_file_type")
  })
})
