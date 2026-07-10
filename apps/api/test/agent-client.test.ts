import { test, expect } from "bun:test"
import { createRun, rewriteChapter, ragIndex, ragDelete } from "../src/services/agent-client"

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
