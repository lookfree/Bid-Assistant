import { test, expect } from "bun:test"
import { createRun, rewriteChapter, ragIndex, ragDelete, testModel, listModels } from "../src/services/agent-client"

function fakeFetch(capture: { body?: any }) {
  return (async (_url: string, init: any) => {
    capture.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ run_id: "r1" }), { status: 200 })
  }) as unknown as typeof fetch
}

function fakeFetchCapturingUrl(capture: { url?: string; init?: any }) {
  return (async (url: string, init: any) => {
    capture.url = url
    capture.init = init
    return new Response("{}", { status: 200 })
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

test("createRun 带 userId → body.user_id", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {}, userId: "u1" })
    expect(cap.body.user_id).toBe("u1")
  } finally { (globalThis as any).fetch = orig }
})

test("createRun 不带 userId → 请求体无 user_id 字段", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {} })
    expect("user_id" in cap.body).toBe(false)
  } finally { (globalThis as any).fetch = orig }
})

test("rewriteChapter 带 userId → body.user_id", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async (_url: string, init: any) => {
    cap.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ chapter_id: "ch-1", html: "<p>x</p>" }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    await rewriteChapter({ agentType: "bidding_agent", threadId: "t1", chapterId: "ch-1", instruction: "x", userId: "u1" })
    expect(cap.body.user_id).toBe("u1")
  } finally { (globalThis as any).fetch = orig }
})

test("rewriteChapter 不带 userId → 请求体无 user_id 字段", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async (_url: string, init: any) => {
    cap.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ chapter_id: "ch-1", html: "<p>x</p>" }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    await rewriteChapter({ agentType: "bidding_agent", threadId: "t1", chapterId: "ch-1", instruction: "x" })
    expect("user_id" in cap.body).toBe(false)
  } finally { (globalThis as any).fetch = orig }
})

test("ragIndex POST 到 /rag/index，body 含 snake_case 契约字段", async () => {
  const cap: { url?: string; init?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetchCapturingUrl(cap)
  try {
    await ragIndex({ userId: "u1", sourceId: "item-1", title: "标题", text: "正文" })
    expect(cap.url).toContain("/rag/index")
    expect(cap.init.method).toBe("POST")
    expect(JSON.parse(cap.init.body)).toEqual({
      user_id: "u1",
      source_type: "library",
      source_id: "item-1",
      title: "标题",
      text: "正文",
    })
  } finally { (globalThis as any).fetch = orig }
})

test("ragIndex 非 2xx → 抛错（调用方 try/catch 吞）", async () => {
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  try {
    await expect(ragIndex({ userId: "u1", sourceId: "item-1", title: "t", text: "x" })).rejects.toThrow()
  } finally { (globalThis as any).fetch = orig }
})

test("ragDelete DELETE 到 /rag/index/{sourceType}/{sourceId}?user_id=", async () => {
  const cap: { url?: string; init?: any } = {}
  const orig = (globalThis as any).fetch; (globalThis as any).fetch = fakeFetchCapturingUrl(cap)
  try {
    await ragDelete({ userId: "u1", sourceType: "library", sourceId: "item-1" })
    expect(cap.url).toContain("/rag/index/library/item-1")
    expect(cap.url).toContain("user_id=u1")
    expect(cap.init.method).toBe("DELETE")
  } finally { (globalThis as any).fetch = orig }
})

test("ragDelete 非 2xx → 抛错（调用方 try/catch 吞）", async () => {
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  try {
    await expect(ragDelete({ userId: "u1", sourceType: "library", sourceId: "item-1" })).rejects.toThrow()
  } finally { (globalThis as any).fetch = orig }
})

// spec319.1：testModel/listModels 支持自建端点（base_url/api_key）。
test("testModel 带 base_url/api_key → 原样透传给 agent /models/test", async () => {
  const cap: { url?: string; body?: any } = {}
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async (url: string, init: any) => {
    cap.url = url
    cap.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ ok: true, latency_ms: 50, tokens: 3 }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    const out = await testModel({ provider: "custom", model: "qwen-x", base_url: "http://h:8000/v1", api_key: "sk-x" })
    expect(cap.url).toContain("/models/test")
    expect(cap.body).toEqual({ provider: "custom", model: "qwen-x", base_url: "http://h:8000/v1", api_key: "sk-x" })
    expect(out).toEqual({ ok: true, latencyMs: 50, tokens: 3 })
  } finally { (globalThis as any).fetch = orig }
})

test("testModel 不带 base_url/api_key → 请求体无该字段（注册表路径不回归）", async () => {
  const cap: { body?: any } = {}
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async (_url: string, init: any) => {
    cap.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    await testModel({ provider: "deepseek" })
    expect("base_url" in cap.body).toBe(false)
    expect("api_key" in cap.body).toBe(false)
  } finally { (globalThis as any).fetch = orig }
})

test("listModels POST 到 /models/list-models，body snake {base_url,api_key}", async () => {
  const cap: { url?: string; body?: any } = {}
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async (url: string, init: any) => {
    cap.url = url
    cap.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ ok: true, models: ["qwen2.5-72b", "qwen2.5-7b"] }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    const out = await listModels({ baseUrl: "http://h:8000/v1", apiKey: "sk-x" })
    expect(cap.url).toContain("/models/list-models")
    expect(cap.body).toEqual({ base_url: "http://h:8000/v1", api_key: "sk-x" })
    expect(out).toEqual({ ok: true, models: ["qwen2.5-72b", "qwen2.5-7b"] })
  } finally { (globalThis as any).fetch = orig }
})

test("listModels 失败探针 → agent 恒回 {ok:false,error}，原样透传（永不抛）", async () => {
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async () => new Response(JSON.stringify({ ok: false, error: "连接超时" }), { status: 200 })) as unknown as typeof fetch
  try {
    const out = await listModels({ baseUrl: "http://unreachable:9/v1", apiKey: "sk-x" })
    expect(out).toEqual({ ok: false, error: "连接超时" })
  } finally { (globalThis as any).fetch = orig }
})

import { relayStream } from "../src/services/agent-client"

test("relayStream 心跳：读取间隙超过 heartbeatMs 时插入 ': hb' 注释帧，数据帧照常透传", async () => {
    const enc = new TextEncoder()
    let call = 0
    const reader = {
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
          call++
          if (call === 1) setTimeout(() => res({ done: false, value: enc.encode("event: run.start\n\n") }), 40)
          else res({ done: true })
        }),
    }
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async () => ({ body: { getReader: () => reader } })
    try {
      const out: string[] = []
      for await (const chunk of relayStream("r1", 10)) out.push(chunk)
      expect(out.some((c) => c.startsWith(": hb"))).toBe(true)
      expect(out.some((c) => c.includes("run.start"))).toBe(true)
      expect(out.filter((c) => c.includes("run.start")).length).toBe(1)
    } finally {
      ;(globalThis as any).fetch = orig
    }
})
