// spec 2026-08-08-library-pdf-pages：中转端点。agent 调用可注入，测试永不外呼。
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import {
  AgentUnavailableError,
  PdfPagesRejectedError,
  convertPdfToPages,
} from "../src/services/files"
import { createUserWithIdentity } from "../src/repos/users"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, type User } from "../src/db/schema"
import { bucket } from "../src/storage/s3"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

const createdUserIds: string[] = []

// 建一个测试用户（同款 phone identity 手法，抄 test/services/files.test.ts）。
async function makeUser(): Promise<User> {
  const user = await createUserWithIdentity({
    provider: "phone",
    identifier: uniquePhone(),
    verifiedAt: new Date(),
  })
  createdUserIds.push(user.id)
  return user
}

// 直接落一行 status=uploaded 的 project_files 记录——本测试只走 convertPdfToPages，
// 不经浏览器直传三段式，源文件字节本身与本用例无关，因此不做真实 PUT。
async function makeUploadedPdf(
  filename: string,
  size = 1024,
): Promise<{ userId: string; fileId: string }> {
  const user = await makeUser()
  const [row] = await getDb()
    .insert(projectFiles)
    .values({
      userId: user.id,
      bucket: bucket(),
      key: `uploads/${user.id}/${randomUUID()}/${filename}`,
      filename,
      contentType: "application/pdf",
      size,
      status: "uploaded",
    })
    .returning()
  return { userId: user.id, fileId: row!.id }
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await getDb().delete(users).where(inArray(users.id, createdUserIds)) // 级联删 project_files
  }
  await closeDb()
})

describe("convertPdfToPages", () => {
  it("成功：为每页建 uploaded 文件记录，归属同原文件，名字带页序", async () => {
    const { userId, fileId } = await makeUploadedPdf("检测证书.pdf")
    const callAgent = async (_key: string) => ({
      pages: [
        { key: "derived/x/page-1.png", width: 1600, height: 2263 },
        { key: "derived/x/page-2.png", width: 1600, height: 2263 },
      ],
    })
    const out = await convertPdfToPages(fileId, userId, callAgent)
    expect(out.pages.map((p) => p.name)).toEqual(["检测证书-第1页.png", "检测证书-第2页.png"])

    // 建的记录可按归属查回，status=uploaded，contentType=image/png
    const rows = await getDb()
      .select()
      .from(projectFiles)
      .where(
        inArray(
          projectFiles.id,
          out.pages.map((p) => p.fileId),
        ),
      )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.userId).toBe(userId)
      expect(row.status).toBe("uploaded")
      expect(row.contentType).toBe("image/png")
    }
  })

  it("非 pdf 文件名 → not_pdf", async () => {
    const { userId, fileId } = await makeUploadedPdf("照片.jpg")
    await expect(
      convertPdfToPages(fileId, userId, async () => ({ pages: [] })),
    ).rejects.toThrow(PdfPagesRejectedError)
    try {
      await convertPdfToPages(fileId, userId, async () => ({ pages: [] }))
    } catch (e) {
      expect((e as PdfPagesRejectedError).code).toBe("not_pdf")
    }
  })

  it("超 20MB → too_large；agent 422 错误码原样透传；agent 连不上 → AgentUnavailableError", async () => {
    // 段 1：size 21MB 的行 → code "too_large"
    const tooLarge = await makeUploadedPdf("超大标书.pdf", 21 * 1024 * 1024)
    try {
      await convertPdfToPages(tooLarge.fileId, tooLarge.userId, async () => ({ pages: [] }))
      throw new Error("expected too_large to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PdfPagesRejectedError)
      expect((e as PdfPagesRejectedError).code).toBe("too_large")
    }

    // 段 2：callAgent 抛 PdfPagesRejectedError("too_many_pages") → 透传
    const tooManyPages = await makeUploadedPdf("超多页.pdf")
    try {
      await convertPdfToPages(tooManyPages.fileId, tooManyPages.userId, async () => {
        throw new PdfPagesRejectedError("too_many_pages")
      })
      throw new Error("expected too_many_pages to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PdfPagesRejectedError)
      expect((e as PdfPagesRejectedError).code).toBe("too_many_pages")
    }

    // 段 3：agent 连不上（真实 fetch 抛 TypeError）→ AgentUnavailableError。
    // 这段验证的是默认实现 agentPdfPages 自身的网络失败翻译，因此不注入 callAgent，
    // 而是临时替身全局 fetch（不发真实请求，"测试永不外呼"）。
    const unreachable = await makeUploadedPdf("连不上agent.pdf")
    // tsconfig.bun.json 的 lib 不含 DOM，globalThis 上没有 fetch 的类型声明，
    // 借道 unknown 落地读写（仅本段测试内临时替身，finally 里原样复位）。
    const globalWithFetch = globalThis as unknown as { fetch: typeof fetch }
    const originalFetch = globalWithFetch.fetch
    globalWithFetch.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    try {
      await expect(
        convertPdfToPages(unreachable.fileId, unreachable.userId),
      ).rejects.toThrow(AgentUnavailableError)
    } finally {
      globalWithFetch.fetch = originalFetch
    }
  })

  it("他人文件 → FileNotFoundError（404 语义，防越权探测）", async () => {
    const { fileId } = await makeUploadedPdf("检测证书.pdf")
    const stranger = await makeUser()
    await expect(
      convertPdfToPages(fileId, stranger.id, async () => ({ pages: [] })),
    ).rejects.toThrow("not_found")
  })
})
