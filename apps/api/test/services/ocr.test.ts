/**
 * OCR 客户端（App → 231 上的独立 OCR 容器）。
 *
 * 这层最容易悄悄坏掉的地方不是"识别得准不准"，而是**请求根本没发对**：
 * base URL 多一个尾斜杠、max_chars 没带过去、错误状态被当成成功——
 * 这些都不会报错，只会让 <img alt> 里少了识别文字，最终表现成"审查看不见证照"，
 * 而那正是 2026-08-06 用户反馈的原始故障。所以用一个桩服务把请求形状钉死。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { resetEnvCacheForTest } from "../../src/config/env"

type Hit = { path: string; body: { image?: string; max_chars?: number } }
const hits: Hit[] = []
let reply: { status: number; body: unknown } = { status: 200, body: { text: "" } }
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      hits.push({ path: url.pathname, body: (await req.json()) as Hit["body"] })
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      })
    },
  })
  // 尾斜杠是故意的：真实 env 里手写地址常带斜杠。注意 Bun 的 fetch 会把 //ocr 归一成 /ocr，
  // 所以客户端那句 replace(/\/$/,"") 在这里观察不到——别拿本文件的断言当它的守卫。
  process.env.OCR_BASE_URL = `http://127.0.0.1:${server.port}/`
  resetEnvCacheForTest() // 同进程里先跑的测试文件可能已经把 env 缓存住了
})

afterAll(() => {
  server.stop(true)
  delete process.env.OCR_BASE_URL // 桩服务已停，别把死地址留给同进程的其他测试
  resetEnvCacheForTest()
})

// 惰性 import：getEnv 是首次调用时才读 process.env 的单例，必须等上面设完再加载模块。
const load = () => import("../../src/services/ocr")

describe("ocrImage", () => {
  it("打的是 <base>/ocr 这个端点", async () => {
    hits.length = 0
    reply = { status: 200, body: { text: "x" } }
    const { ocrImage } = await load()
    await ocrImage("data:image/png;base64,AAAA")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe("/ocr")
  })

  it("原样带上图片与 max_chars", async () => {
    hits.length = 0
    reply = { status: 200, body: { text: "x" } }
    const { ocrImage } = await load()
    await ocrImage("data:image/png;base64,BBBB", 120)
    expect(hits[0]!.body.image).toBe("data:image/png;base64,BBBB")
    expect(hits[0]!.body.max_chars).toBe(120)
  })

  it("识别文字去掉首尾空白", async () => {
    reply = { status: 200, body: { text: "  统一社会信用代码 913100  " } }
    const { ocrImage } = await load()
    expect(await ocrImage("data:image/png;base64,CCCC")).toBe("统一社会信用代码 913100")
  })

  it("返回体没有 text 字段时回空串，而不是 undefined", async () => {
    reply = { status: 200, body: {} }
    const { ocrImage } = await load()
    expect(await ocrImage("data:image/png;base64,DDDD")).toBe("")
  })

  it("上游非 200 要抛错——由路由层决定降级，客户端不能把失败伪装成识别不出文字", async () => {
    reply = { status: 500, body: { error: "boom" } }
    const { ocrImage } = await load()
    expect(ocrImage("data:image/png;base64,EEEE")).rejects.toThrow(/ocr_failed_500/)
  })
})
