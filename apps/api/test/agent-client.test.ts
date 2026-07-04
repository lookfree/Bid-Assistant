import { test, expect } from "bun:test"
import { createRun } from "../src/services/agent-client"

function fakeFetch(capture: { body?: any }) {
  return (async (_url: string, init: any) => {
    capture.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ run_id: "r1" }), { status: 200 })
  }) as unknown as typeof fetch
}

test("createRun 带 model 时请求体含 model", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {}, model: { provider: "qwen", model: "qwen-plus", fallbacks: "" } })
    expect(cap.body).toMatchObject({ thread_id: "t1", model: { provider: "qwen", model: "qwen-plus", fallbacks: "" } })
  } finally { (globalThis as any).fetch = orig }
})

test("createRun 不带 model 时请求体无 model 字段", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {} })
    expect("model" in cap.body).toBe(false)
  } finally { (globalThis as any).fetch = orig }
})
