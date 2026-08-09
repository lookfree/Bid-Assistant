/**
 * 附件 OCR 前置存储（services/library-ocr，spec 2026-08-09 基建）。
 *
 * 直调 backfillAttachmentOcr，不走路由层的 fire-and-forget（时序不可控，赌不起）；
 * routes/library.ts 的 POST/PUT 是否真的触发它属于接线，用最后一条 zod 往返测试顺带盖到
 * （经真实路由保存一次，确认 attachmentSchema 没把 ocrText 剥掉——sourceFileId 被剥的教训）。
 */
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout, mock } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { loginWithPhone } from "../src/services/auth"
import { putObject } from "../src/storage/s3"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库 + 真 MinIO

let ocrCalls = 0
let ocrBehavior: (dataUrl: string) => Promise<string> = async () => ""

// mock.module 必须在 services/library-ocr.ts 被首次 import 之前完成替换（ESM 静态 import
// 先于其它语句求值）——本文件因此对 library-ocr（及依赖它的 routes/library）一律用动态 import，
// 手法同 refresh-credentials-appendix-resilience.test.ts。
mock.module("../src/services/ocr", () => ({
  ocrImage: async (dataUrl: string) => {
    ocrCalls++
    return ocrBehavior(dataUrl)
  },
}))

const { backfillAttachmentOcr } = await import("../src/services/library-ocr")

type Attachment = { fileId: string; name: string; sourceFileId?: string; ocrText?: string }

let userId = ""
let token = ""

// 真实写一个 MinIO 对象（内容随意，OCR 走 mock 不关心字节）+ 对应 project_files 行
async function insertImageFile(filename: string): Promise<string> {
  const key = `library-ocr-test/${userId}/${crypto.randomUUID()}/${filename}`
  await putObject(key, new TextEncoder().encode("fake-image-bytes"), "image/png")
  const [row] = await getDb()
    .insert(projectFiles)
    .values({ userId, bucket: "bidsaas", key, filename, contentType: "image/png", size: 16, status: "uploaded" })
    .returning()
  return row!.id
}

// 非图片附件：不需要真实字节，backfill 在 getObjectBytes 之前就该按扩展名跳过
async function insertNonImageFile(filename: string): Promise<string> {
  const [row] = await getDb()
    .insert(projectFiles)
    .values({
      userId,
      bucket: "bidsaas",
      key: `library-ocr-test/${userId}/${crypto.randomUUID()}/${filename}`,
      filename,
      contentType: "application/pdf",
      size: 1,
      status: "uploaded",
    })
    .returning()
  return row!.id
}

async function insertItem(attachments: Attachment[]): Promise<string> {
  const [row] = await getDb()
    .insert(libraryItems)
    .values({ userId, category: "qualification", title: "OCR 测试条目", attachments })
    .returning()
  return row!.id
}

async function loadAttachments(itemId: string): Promise<Attachment[]> {
  const [row] = await getDb().select().from(libraryItems).where(eq(libraryItems.id, itemId))
  return (row?.attachments as Attachment[] | null) ?? []
}

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  userId = a.user.id
  token = a.token
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 条目/文件随 user 级联删
  await closeDb()
})

describe("backfillAttachmentOcr", () => {
  it("①图片附件识别后写回 ocrText", async () => {
    ocrBehavior = async () => "统一社会信用代码91xx"
    const fileId = await insertImageFile("license.png")
    const itemId = await insertItem([{ fileId, name: "license.png" }])

    await backfillAttachmentOcr(itemId, userId)

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.ocrText).toBe("统一社会信用代码91xx")
  })

  it("②已有 ocrText 的附件不重复识别（mock 调用次数不增加）", async () => {
    ocrBehavior = async () => "不应被调用到这个值"
    const fileId = await insertImageFile("license-existing.png")
    const itemId = await insertItem([{ fileId, name: "license-existing.png", ocrText: "已存在的识别文字" }])

    const before = ocrCalls
    await backfillAttachmentOcr(itemId, userId)
    expect(ocrCalls).toBe(before)

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.ocrText).toBe("已存在的识别文字")
  })

  it("③非图片附件跳过，不调用 OCR", async () => {
    ocrBehavior = async () => "不应被调用到这个值"
    const fileId = await insertNonImageFile("contract.pdf")
    const itemId = await insertItem([{ fileId, name: "contract.pdf" }])

    const before = ocrCalls
    await backfillAttachmentOcr(itemId, userId)
    expect(ocrCalls).toBe(before)

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.ocrText).toBeUndefined()
  })

  it("④ocrImage 抛错 → 该附件无 ocrText，backfill 本身不抛（保存不受影响）", async () => {
    ocrBehavior = async () => {
      throw new Error("ocr_failed_500")
    }
    const fileId = await insertImageFile("broken.png")
    const itemId = await insertItem([{ fileId, name: "broken.png" }])

    await expect(backfillAttachmentOcr(itemId, userId)).resolves.toBeUndefined()

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.ocrText).toBeUndefined()
  })

  it("⑤竞态：识别耗时期间用户又保存了一次（附件已变）→ backfill 放弃整列覆写，用户改动完好无损，不抛异常", async () => {
    const fileId = await insertImageFile("racer.png")
    const itemId = await insertItem([{ fileId, name: "racer.png" }])

    // 模拟「用户在识别进行中又保存了一次」：往 attachments 里加一个附件，列值因此变了。
    // 用 ocrBehavior 的副作用在读快照之后、写回之前插入这次并发更新——正是竞态窗口本身。
    const raceFileId = await insertNonImageFile("added-during-race.pdf")
    const userChange: Attachment[] = [
      { fileId, name: "racer.png" },
      { fileId: raceFileId, name: "added-during-race.pdf" },
    ]
    ocrBehavior = async () => {
      await getDb().update(libraryItems).set({ attachments: userChange }).where(eq(libraryItems.id, itemId))
      return "识别文字（应被放弃，不该写回）"
    }

    await expect(backfillAttachmentOcr(itemId, userId)).resolves.toBeUndefined() // 竞态不该抛异常

    const atts = await loadAttachments(itemId)
    expect(atts).toEqual(userChange) // 用户的并发改动原封不动，没被旧快照的整列覆写吞掉
    expect(atts.some((a) => a.ocrText)).toBe(false) // OCR 结果确实被放弃了，没有半路混进最终结果
  })

  it("⑥zod 往返：带 ocrText 的附件经真实路由保存查回仍在（防 attachmentSchema 静默剥字段）", async () => {
    const { libraryRoutes } = await import("../src/routes/library")
    const app = new Hono()
    app.route("/api/library", libraryRoutes())
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" }

    const fileId = await insertImageFile("pre-ocr.png")
    const created = await app.request("/api/library", {
      method: "POST",
      headers,
      body: JSON.stringify({
        category: "qualification",
        title: "已预置识别文字的证书",
        attachments: [{ fileId, name: "pre-ocr.png", ocrText: "预置识别文字" }],
      }),
    })
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: string; attachments: Attachment[] }
    expect(row.attachments[0]?.ocrText).toBe("预置识别文字") // POST 响应即应保留

    // 查回（真正落库后重读，而非只信任 insert().returning() 的回显）
    const reloaded = await loadAttachments(row.id)
    expect(reloaded[0]?.ocrText).toBe("预置识别文字")
  })
})
