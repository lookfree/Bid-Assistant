/**
 * 附件正文解析入索引（services/library-text + routes/library 的 indexText，spec 2026-08-11）。
 *
 * 用户需求：资料库条目的附件正文要能被 RAG 检索到（此前 indexText 只索引 title/meta/fields/body，
 * 用户传的 docx/pdf 附件内容完全不进检索，系统只看得见标题）。
 *
 * 解析走第三参注入（默认真实 parseAttachmentText，与 services/library-ocr 的 ocr 注入同一手法）——
 * 不用 mock.module：那是进程级全局替换模块表，同进程全量跑时会泄漏给 agent-client 的其它测试文件。
 */
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { loginWithPhone } from "../src/services/auth"
import { libraryRoutes, enrichAttachments, type LibraryDeps } from "../src/routes/library"
import {
  backfillAttachmentText,
  ATTACHMENT_TEXT_MAX_CHARS,
  ITEM_TEXT_BUDGET_CHARS,
  PARSE_MAX_BYTES,
} from "../src/services/library-text"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

type Attachment = { fileId: string; name: string; ocrText?: string; text?: string }
type ParseResult = {
  text: string
  kind: string
  chars: number
  truncated: boolean
  image_pages: number
  ocr_pages: number
  no_text: boolean
}

const ok = (text: string): ParseResult => ({
  text,
  kind: "docx",
  chars: text.length,
  truncated: false,
  image_pages: 0,
  ocr_pages: 0,
  no_text: false,
})

let parseCalls: Array<{ key: string; maxChars: number }> = []
let parseBehavior: (key: string, maxChars: number) => Promise<ParseResult> = async () => ok("默认解析正文")
const parseStub = async (opts: { key: string; maxChars: number }) => {
  parseCalls.push(opts)
  return parseBehavior(opts.key, opts.maxChars)
}

let userId = ""
let token = ""

async function insertFile(filename: string, contentType: string, size = 1024): Promise<string> {
  const [row] = await getDb()
    .insert(projectFiles)
    .values({
      userId,
      bucket: "bidsaas",
      key: `library-text-test/${userId}/${crypto.randomUUID()}/${filename}`,
      filename,
      contentType,
      size,
      status: "uploaded",
    })
    .returning()
  return row!.id
}

const insertDocx = (filename = "零信任统一身份认证技术方案.docx", size = 1024) =>
  insertFile(filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size)
const insertImage = (filename = "license.png") => insertFile(filename, "image/png")

async function insertItem(attachments: Attachment[], body?: string): Promise<string> {
  const [row] = await getDb()
    .insert(libraryItems)
    .values({ userId, category: "text", title: "零信任技术方案", attachments, body })
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

describe("backfillAttachmentText（文档附件正文解析回写）", () => {
  it("①docx 附件解析后写回 attachments[].text", async () => {
    parseBehavior = async () => ok("零信任以身份为中心，默认不信任、持续验证。")
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "零信任统一身份认证技术方案.docx" }])

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(true)

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.text).toBe("零信任以身份为中心，默认不信任、持续验证。")
  })

  it("②图片附件不走文本解析（仍归 ocrText 管），parse 一次都不该被调", async () => {
    parseCalls = []
    const fileId = await insertImage()
    const itemId = await insertItem([{ fileId, name: "license.png" }])

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(false)
    expect(parseCalls).toHaveLength(0)

    const atts = await loadAttachments(itemId)
    expect(atts[0]?.text).toBeUndefined()
  })

  it("③已有 text 的附件不重复解析", async () => {
    parseCalls = []
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "a.docx", text: "已解析过的正文" }])

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(false)
    expect(parseCalls).toHaveLength(0)
  })

  it("④超大文件解析前就被拒（连 agent 都不调）", async () => {
    parseCalls = []
    const fileId = await insertDocx("300MB 手册.docx", PARSE_MAX_BYTES + 1)
    const itemId = await insertItem([{ fileId, name: "300MB 手册.docx" }])

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(false)
    expect(parseCalls).toHaveLength(0)
    expect((await loadAttachments(itemId))[0]?.text).toBeUndefined()
  })

  it("⑤超长文本按单附件上限截断（agent 失约也不会写超 zod 上限的值）", async () => {
    parseBehavior = async () => ok("字".repeat(ATTACHMENT_TEXT_MAX_CHARS + 5000))
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "长文.docx" }])

    await backfillAttachmentText(itemId, userId, parseStub)

    const text = (await loadAttachments(itemId))[0]?.text ?? ""
    expect(text.length).toBe(ATTACHMENT_TEXT_MAX_CHARS)
  })

  it("⑥条目合计上限：预算用尽后的附件不再解析", async () => {
    parseCalls = []
    parseBehavior = async () => ok("字".repeat(ATTACHMENT_TEXT_MAX_CHARS))
    const n = Math.ceil(ITEM_TEXT_BUDGET_CHARS / ATTACHMENT_TEXT_MAX_CHARS)
    const atts: Attachment[] = []
    for (let i = 0; i <= n; i++) atts.push({ fileId: await insertDocx(`第${i}份.docx`), name: `第${i}份.docx` })
    const itemId = await insertItem(atts)

    await backfillAttachmentText(itemId, userId, parseStub)

    const saved = await loadAttachments(itemId)
    const total = saved.reduce((sum, a) => sum + (a.text?.length ?? 0), 0)
    expect(total).toBeLessThanOrEqual(ITEM_TEXT_BUDGET_CHARS)
    expect(saved.at(-1)?.text).toBeUndefined() // 预算用尽的那份没解析
    expect(parseCalls).toHaveLength(n) // 也没白调 agent
  })

  it("⑦解析失败（agent 422/不可达）→ 该附件无 text，函数不抛，条目原样", async () => {
    parseBehavior = async () => {
      throw new Error("agent http 422")
    }
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "坏文件.docx" }])

    await expect(backfillAttachmentText(itemId, userId, parseStub)).resolves.toBe(false)
    expect((await loadAttachments(itemId))[0]?.text).toBeUndefined()
  })

  it("⑧扫描件（no_text）→ 不写空 text，不在这里触发 OCR", async () => {
    parseBehavior = async () => ({
      text: "",
      kind: "pdf",
      chars: 0,
      truncated: false,
      image_pages: 12,
      ocr_pages: 0,
      no_text: true,
    })
    const fileId = await insertFile("扫描版资质.pdf", "application/pdf")
    const itemId = await insertItem([{ fileId, name: "扫描版资质.pdf" }])

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(false)
    expect((await loadAttachments(itemId))[0]?.text).toBeUndefined()
  })

  it("⑨竞态：解析期间用户又保存了一次 → 放弃整列覆写，用户改动完好无损", async () => {
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "racer.docx" }])
    const raceFileId = await insertImage("加进来的.png")
    const userChange: Attachment[] = [
      { fileId, name: "racer.docx" },
      { fileId: raceFileId, name: "加进来的.png" },
    ]
    parseBehavior = async () => {
      await getDb().update(libraryItems).set({ attachments: userChange }).where(eq(libraryItems.id, itemId))
      return ok("解析文字（应被放弃）")
    }

    expect(await backfillAttachmentText(itemId, userId, parseStub)).toBe(false)
    expect(await loadAttachments(itemId)).toEqual(userChange)
  })
})

describe("indexText 并入附件正文", () => {
  const captured: Array<Parameters<LibraryDeps["ragIndex"]>[0]> = []
  const deps: Partial<LibraryDeps> = { ragIndex: async (o) => void captured.push(o) }
  const app = new Hono()
  app.route("/api/library", libraryRoutes(deps))
  const headers = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

  it("⑩无附件时索引文本与既有实现逐字节一致", async () => {
    captured.length = 0
    const res = await app.request("/api/library", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        category: "text",
        title: "ISO27001 认证",
        meta: "证书编号 CN-2025-001",
        fields: [{ label: "发证机构", value: "CNAS" }],
        body: "证书说明正文",
      }),
    })
    expect(res.status).toBe(201)
    expect(captured[0]?.text).toBe("ISO27001 认证\n证书编号 CN-2025-001\n发证机构：CNAS\n证书说明正文")
  })

  it("⑪解析出正文后重建索引，索引文本含附件正文（带附件名）", async () => {
    captured.length = 0
    parseBehavior = async () => ok("零信任 4.0 支持国密算法与终端环境感知。")
    const fileId = await insertDocx()
    const itemId = await insertItem([{ fileId, name: "零信任产品介绍.docx" }], "条目正文")

    await enrichAttachments(deps.ragIndex!, userId, itemId, parseStub)

    expect(captured).toHaveLength(1)
    expect(captured[0]?.text).toContain("条目正文")
    expect(captured[0]?.text).toContain("零信任产品介绍.docx")
    expect(captured[0]?.text).toContain("零信任 4.0 支持国密算法与终端环境感知。")
  })

  it("⑫没解析出新正文时不重复建索引（省一次 embed）", async () => {
    captured.length = 0
    const fileId = await insertImage()
    const itemId = await insertItem([{ fileId, name: "只有图片.png" }])

    await enrichAttachments(deps.ragIndex!, userId, itemId, parseStub)

    expect(captured).toHaveLength(0)
  })

  it("⑬zod 往返：带 text 的附件经真实路由保存查回仍在（防 attachmentSchema 静默剥字段）", async () => {
    const fileId = await insertDocx()
    const created = await app.request("/api/library", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        category: "text",
        title: "已带正文的条目",
        attachments: [{ fileId, name: "预置.docx", text: "预置附件正文" }],
      }),
    })
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: string; attachments: Attachment[] }
    expect(row.attachments[0]?.text).toBe("预置附件正文") // POST 响应即应保留
    expect((await loadAttachments(row.id))[0]?.text).toBe("预置附件正文") // 真正落库后重读
  })
})
