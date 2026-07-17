import { api, type RequestFn } from "./api"

// 用户反馈/申诉入口前端封装（spec326）：建在共享 api.request 上，鉴权头/baseUrl/401 语义全部复用。
// money-blind：/api/feedback 免费，不与积分账本发生交互；后端字段即此 camelCase 形状（Task A 已定）。

export const FEEDBACK_TYPES = ["content_error", "complaint", "billing", "suggestion", "other"] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export type FeedbackItem = {
  id: string
  type: FeedbackType
  content: string
  contact: string | null
  status: "pending" | "processing" | "resolved"
  reply: string | null
  createdAt: string
  handledAt: string | null
}

export function createFeedbackApi(request: RequestFn) {
  return {
    submit: (body: { type: FeedbackType; content: string; contact?: string }) =>
      request<FeedbackItem>("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
    list: () => request<{ items: FeedbackItem[] }>("/api/feedback"),
  }
}

export const feedbackApi = createFeedbackApi(api.request)
