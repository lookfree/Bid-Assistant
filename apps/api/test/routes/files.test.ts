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
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
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

  // —— /files/ocr ——
  // 这个端点的合同是「**失败一律降级成空串**」：识别是增强，不是插图的前置条件。
  // 退化方向很隐蔽——把降级改成抛错，用户看到的是"插图失败"，而不是"没识别出文字"。
  describe("/files/ocr", () => {
    it("未鉴权 -> 401", async () => {
      const res = await app.request("/files/ocr", { method: "POST", body: "{}" })
      expect(res.status).toBe(401)
    })

    it("没给图片 -> 400", async () => {
      const res = await app.request("/files/ocr", { method: "POST", headers: auth(), body: "{}" })
      expect(res.status).toBe(400)
    })

    it("图片过大 -> 413（不把十几 MB 再转发给 OCR 容器）", async () => {
      const huge = JSON.stringify({ image: "d".repeat(12 * 1024 * 1024 + 1) })
      const res = await app.request("/files/ocr", { method: "POST", headers: auth(), body: huge })
      expect(res.status).toBe(413)
    })

    it("OCR 不可用 -> 200 且 text 为空（插图不受影响）", async () => {
      // 不去动 process.env：getEnv 是缓存单例，在这里删变量会影响同进程里的其他测试文件
      // （实测把 test/services/ocr.test.ts 整个搞挂）。
      // 这串 base64 解不出图片，所以三种环境下结论一致：没配 OCR -> 直接降级；
      // 配了（真服务或桩）-> 上游报错 -> 同样降级。断言因此是稳的。
      const body = JSON.stringify({ image: "data:image/png;base64,AAAAAAAAAAAA" })
      const res = await app.request("/files/ocr", { method: "POST", headers: auth(), body })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ text: "" })
    })
  })

  it("presign(.docx 白名单放行) -> PUT -> complete -> download-url 全链路", async () => {
    // 内容字节现在**会**被校验：confirmUpload 按文件头判定内容与扩展名相符
    // （加密封装/改错扩展名的文件在此拦下，见 services/file-magic.ts），所以 .docx 的
    // 测试用体必须带 OOXML 的 ZIP 头，不能再用纯文本。
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("tender-bytes")])
    const pre = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "t.docx", contentType: "text/plain", size: body.byteLength }),
    })
    expect(pre.status).toBe(200)
    const { fileId, uploadUrl } = (await pre.json()) as { fileId: string; uploadUrl: string }
    await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body })

    const done = await app.request(`/files/${fileId}/complete`, { method: "POST", headers: auth() })
    expect(done.status).toBe(200)
    expect(((await done.json()) as { file: { status: string } }).file.status).toBe("uploaded")

    const dl = await app.request(`/files/${fileId}/download-url`, { headers: auth() })
    const { url } = (await dl.json()) as { url: string }
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(body)
  })

  it("扩展名白名单：.doc/.xls 老格式 → 200 现已支持（spec320 agent 侧 LibreOffice 转换）", async () => {
    const doc = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "老标书.doc", contentType: "application/msword", size: 10 }),
    })
    expect(doc.status).toBe(200)
    const xls = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "登记表.xls", contentType: "application/vnd.ms-excel", size: 10 }),
    })
    expect(xls.status).toBe(200)
  })

  it("扩展名白名单：.png/.jpg/.jpeg 证照图片 → 200 现已支持（spec325 资质证照附件）", async () => {
    for (const filename of ["证照.png", "证照.jpg", "证照.jpeg"]) {
      const res = await app.request("/files/presign-upload", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ filename, contentType: "image/png", size: 10 }),
      })
      expect(res.status).toBe(200)
    }
  })

  it("扩展名白名单：.pptx/.potx 企业 PPT 母版 → 200 现已支持（企业 PPT 母版套用）", async () => {
    for (const filename of ["企业模板.pptx", "企业模板.potx"]) {
      const res = await app.request("/files/presign-upload", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          filename,
          contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          size: 10,
        }),
      })
      expect(res.status).toBe(200)
    }
  })

  it("扩展名白名单：其余不支持的扩展名（如 .zip）→ 400 unsupported_file_type（解析层必败，入口 fail fast）", async () => {
    const res = await app.request("/files/presign-upload", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ filename: "附件.zip", contentType: "application/zip", size: 10 }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_file_type")
  })
})
