import { describe, it, expect } from "bun:test"
import { createFeedbackApi } from "../lib/feedback-api"
import { ApiError } from "../lib/api-client"

// 记录调用的假 request（不碰全局 fetch；URL/method/body 断言），照 membership-api.test.ts 的注入模式。
function recorder() {
  const calls: { path: string; init?: RequestInit }[] = []
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, init })
    return {} as T
  }
  return { calls, api: createFeedbackApi(request) }
}

describe("spec326 feedback-api 封装", () => {
  it("submit → POST /api/feedback，body 为 {type,content,contact}", async () => {
    const { calls, api } = recorder()
    await api.submit({ type: "content_error", content: "生成内容有误", contact: "138xxxx0000" })
    expect(calls[0]!.path).toBe("/api/feedback")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      type: "content_error",
      content: "生成内容有误",
      contact: "138xxxx0000",
    })
  })

  it("list → GET /api/feedback，解析 items", async () => {
    const item = {
      id: "fb-1",
      type: "suggestion" as const,
      content: "建议",
      contact: null,
      status: "pending" as const,
      reply: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      handledAt: null,
    }
    const request = async <T>(_path: string): Promise<T> => ({ items: [item] }) as T
    const api = createFeedbackApi(request)
    const r = await api.list()
    expect(r.items).toEqual([item])
  })

  it("429 抛 ApiError 且 code=too_many_feedback", async () => {
    const request = async () => {
      throw new ApiError(429, "too_many_feedback")
    }
    const api = createFeedbackApi(request)
    await expect(api.submit({ type: "other", content: "x" })).rejects.toMatchObject({
      status: 429,
      code: "too_many_feedback",
    })
  })
})
