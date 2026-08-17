import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, projectFiles } from "../src/db/schema"
import { stepEta } from "../src/services/step-eta"
import { loginWithPhone } from "../src/services/auth"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

/* 各步预估总时长（2026-08-17 用户要求：进度条覆盖整步 + 预估总时间）。
   230 实测 P90 是中位数的 4~7 倍，差别几乎全来自标书规模——所以必须带规模因子，
   只报中位数会让大标书用户觉得被骗。 */

let userId = ""
let smallId = ""
let bigId = ""
let docId = ""

async function project(name: string, files: Array<[string, string, number]>) {
  for (const [key, filename, size] of files) {
    await getDb().insert(projectFiles).values({
      userId,
      bucket: "bidsaas",
      key,
      filename,
      contentType: "application/octet-stream",
      size,
      status: "uploaded",
    })
  }
  const [p] = await getDb()
    .insert(bidProjects)
    .values({
      userId,
      threadId: `proj-${crypto.randomUUID()}`,
      name,
      tenderFileKey: files[0]![0],
      tenderFileKeys: files.map(([k]) => k),
    })
    .returning()
  return p!.id
}

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  userId = r.user.id
  smallId = await project("小标书", [[`u/${crypto.randomUUID()}.docx`, "小.docx", 100_000]])
  bigId = await project("大标书", [[`u/${crypto.randomUUID()}.docx`, "大.docx", 3_000_000]])
  docId = await project("老式 doc", [[`u/${crypto.randomUUID()}.doc`, "老式.doc", 1_000_000]])
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

describe("步骤预估总时长", () => {
  it("没有历史样本时用实测常数兜底，且如实标注 basis=default", async () => {
    const eta = await stepEta(smallId, "read")
    expect(eta.basis).toBe("default")
    expect(eta.seconds).toBeGreaterThan(0)
  })

  it("大标书的预估显著高于小标书——只报一个中位数就是在骗大标书用户", async () => {
    const small = await stepEta(smallId, "read")
    const big = await stepEta(bigId, "read")
    expect(big.seconds).toBeGreaterThan(small.seconds)
  })

  it(".doc 比同体量 .docx 慢（LibreOffice 转换 + 扫描页 OCR）", async () => {
    const doc = await stepEta(docId, "read")
    const docx = await stepEta(smallId, "read")
    expect(doc.seconds).toBeGreaterThan(docx.seconds)
  })

  it("正文按用户选的目标字数缩放", async () => {
    const few = await stepEta(smallId, "content", 20_000)
    const many = await stepEta(smallId, "content", 80_000)
    expect(many.seconds).toBeGreaterThan(few.seconds)
  })

  it("因子夹紧：极端体量也不会给出荒唐数字（不超基准 3 倍、不低于 0.5 倍）", async () => {
    const huge = await stepEta(smallId, "content", 10_000_000)
    const tiny = await stepEta(smallId, "content", 1)
    expect(huge.seconds).toBeLessThanOrEqual(1600 * 3 + 10)
    expect(tiny.seconds).toBeGreaterThanOrEqual(1600 * 0.5 - 10)
  })

  it("有足够历史样本时改用历史中位数（basis=history）", async () => {
    // 造 3 条已完成的 outline 步：起止差 600 秒
    for (let i = 0; i < 3; i++) {
      const pid = await project(`历史${i}`, [[`u/${crypto.randomUUID()}.docx`, "h.docx", 1_000_000]])
      const start = new Date(Date.now() - 3600_000 - i * 1000)
      await getDb().insert(projectSteps).values({
        projectId: pid,
        step: "outline",
        status: "done",
        createdAt: start,
        finishedAt: new Date(start.getTime() + 600_000),
      })
    }
    const eta = await stepEta(bigId, "outline")
    expect(eta.basis).toBe("history")
    expect(eta.samples).toBeGreaterThanOrEqual(3)
    expect(eta.seconds).toBeGreaterThan(600) // 600s 中位 × 大标书规模因子
  })
})
