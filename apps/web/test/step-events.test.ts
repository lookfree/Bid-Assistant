import { describe, it, expect, afterEach } from "bun:test"
import { openStepEvents, type StepLiveEvent } from "../lib/project"

/** 造一条一次性 SSE 响应：帧按序写完即关流（模拟服务端结束连接）。 */
function sse(...frames: string[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f))
        c.close()
      },
    }),
    { status: 200 },
  )
}

function frame(data: Record<string, unknown>): string {
  return `event: progress\ndata: ${JSON.stringify({ type: "progress", data })}\n\n`
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("等待超时")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe("openStepEvents 断线重连", () => {
  // 生产事故：订阅（start() 里 setRunning(true) 触发）比 POST 建 run 早约 1s，服务端查不到
  // runId 就发 idle 关流；不重连的话该 run 之后的 407 条事件全丢——读标 6 分钟只显示兜底文案、
  // 招标原文一条不显示。
  it("首连撞上 run 未建好（idle 即关流）→ 自动重连并完整拿到进度事件", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return sse("event: idle\ndata: {}\n\n")
      return sse(
        frame({ kind: "read_sections", sections: [{ id: "sec-1-c1", text: "投标人须知" }] }),
        frame({ kind: "phase", label: "读标·并行提取中" }),
        "event: run.end\ndata: {}\n\n",
      )
    }) as unknown as typeof fetch

    const got: StepLiveEvent[] = []
    const cancel = openStepEvents("p1", "read", (e) => got.push(e))
    await waitFor(() => got.some((e) => e.kind === "end"))
    cancel()

    expect(calls).toBe(2)
    // reset 必须先于回放事件到达：否则重连回放会把条款叠两遍
    expect(got.map((e) => e.kind)).toEqual(["reset", "readSections", "phase", "end"])
  })

  it("收到 run.end 后不再重连（本步已结束）", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return sse(frame({ kind: "phase", label: "读标·并行提取中" }), "event: run.end\ndata: {}\n\n")
    }) as unknown as typeof fetch

    const got: StepLiveEvent[] = []
    const cancel = openStepEvents("p1", "read", (e) => got.push(e))
    await waitFor(() => got.some((e) => e.kind === "end"))
    await new Promise((r) => setTimeout(r, 1300)) // 跨过一个重连间隔，确认没有第二次连接
    cancel()

    expect(calls).toBe(1)
    expect(got.map((e) => e.kind)).toEqual(["phase", "end"])
  })

  it("取消订阅后不再重连（页面离开/步骤结束）", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return sse("event: idle\ndata: {}\n\n")
    }) as unknown as typeof fetch

    const cancel = openStepEvents("p1", "read", () => {})
    await waitFor(() => calls >= 1)
    cancel()
    await new Promise((r) => setTimeout(r, 1300))

    expect(calls).toBe(1)
  })
})
