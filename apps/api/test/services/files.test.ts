import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import {
  presignUpload,
  confirmUpload,
  presignDownload,
  FileContentRejectedError,
} from "../../src/services/files"
import { TSD_WRAPPER_HEADER } from "../../src/services/file-magic"
import { createUserWithIdentity } from "../../src/repos/users"
import { getDb, closeDb } from "../../src/db/client"
import { users, projectFiles } from "../../src/db/schema"
import { deleteObject } from "../../src/storage/s3"
import { uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB + MinIO

let userId = ""

beforeAll(async () => {
  userId = (await createUserWithIdentity({ provider: "phone", identifier: uniquePhone(), verifiedAt: new Date() })).id
})
afterAll(async () => {
  const rows = await getDb().select().from(projectFiles).where(eq(projectFiles.userId, userId))
  for (const r of rows) await deleteObject(r.key).catch(() => {})
  await getDb().delete(users).where(eq(users.id, userId)) // 级联删 project_files
  await closeDb()
})

const DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** confirmUpload 现在按文件头校验内容，测试用体必须带真实魔数（ZIP 头 = OOXML 容器）。 */
function docxBody(tail: string): Uint8Array<ArrayBuffer> {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  const rest = new TextEncoder().encode(tail)
  const out = new Uint8Array(new ArrayBuffer(zip.length + rest.length))
  out.set(zip)
  out.set(rest, zip.length)
  return out
}

/** presign -> PUT -> confirm，返回 confirm 的 promise（供断言成功或拒绝）。 */
async function upload(userId: string, filename: string, body: Uint8Array) {
  const { fileId, uploadUrl } = await presignUpload({
    userId,
    filename,
    contentType: DOCX_CT,
    size: body.byteLength,
  })
  await fetch(uploadUrl, { method: "PUT", headers: { "content-type": DOCX_CT }, body })
  return { fileId, confirm: () => confirmUpload(fileId, userId) }
}

describe("files service", () => {
  it("presign -> PUT -> confirm 落 uploaded -> download 取回一致", async () => {
    const body = docxBody("招标文件示例")
    const { fileId, confirm } = await upload(userId, "tender.docx", body)

    const file = await confirm()
    expect(file.status).toBe("uploaded")
    expect(file.size).toBe(body.byteLength)

    const { url, filename } = await presignDownload(fileId, userId)
    expect(filename).toBe("tender.docx")
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(body)
  })

  it("别人无法下载我的文件", async () => {
    const { fileId } = await presignUpload({ userId, filename: "a.docx", contentType: DOCX_CT, size: 1 })
    await expect(presignDownload(fileId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow()
  })
})

// 加密封装/内容不符的文件必须在上传确认这一步就被挡住，不能一路走到读标才失败
// （2026-08-05 生产事故：一份被加密软件封装的 .pdf 走到读标，最后报成"模型未提交结构化结果"）。
describe("confirmUpload 内容校验", () => {
  it("被文档加密软件封装的文件：拒绝、说明原因、并删掉对象", async () => {
    const body = new TextEncoder().encode(TSD_WRAPPER_HEADER + "ciphertext…")
    const { fileId, confirm } = await upload(userId, "招标文件.pdf", body)

    await expect(confirm()).rejects.toThrow(FileContentRejectedError)

    const [row] = await getDb().select().from(projectFiles).where(eq(projectFiles.id, fileId))
    expect(row!.status).toBe("pending") // 没被确认为 uploaded，进不了后续流程
  })

  it("内容与扩展名不符（改扩展名/下载不全）：同样拒绝", async () => {
    const { confirm } = await upload(userId, "招标文件.pdf", new TextEncoder().encode("not a pdf"))
    await expect(confirm()).rejects.toThrow(FileContentRejectedError)
  })

  it("真实格式的文件正常通过（回归护栏，不能误伤）", async () => {
    const { confirm } = await upload(userId, "ok.docx", docxBody("正文"))
    expect((await confirm()).status).toBe("uploaded")
  })
})
