import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { presignUpload, confirmUpload, presignDownload } from "../../src/services/files"
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

describe("files service", () => {
  it("presign -> PUT -> confirm 落 uploaded -> download 取回一致", async () => {
    const body = "招标文件示例"
    const { fileId, uploadUrl } = await presignUpload({
      userId,
      filename: "tender.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: Buffer.byteLength(body),
    })
    await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, body })

    const file = await confirmUpload(fileId, userId)
    expect(file.status).toBe("uploaded")
    expect(file.size).toBe(Buffer.byteLength(body))

    const { url, filename } = await presignDownload(fileId, userId)
    expect(filename).toBe("tender.docx")
    expect(await (await fetch(url)).text()).toBe(body)
  })

  it("别人无法下载我的文件", async () => {
    const { fileId } = await presignUpload({ userId, filename: "a.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1 })
    await expect(presignDownload(fileId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow()
  })
})
