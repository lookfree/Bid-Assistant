import { createApiClient } from "./api-client"
import { tokenStore } from "./token-store"

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080"

// 令牌失效回调：任意请求 401 时清令牌并通知已注册的监听者（AuthProvider）复位登录态、守卫跳登录。
// 一产一消，直接注册回调即可，无需 DOM 事件总线。
let authExpiredHandler: (() => void) | null = null
export function setAuthExpiredHandler(fn: (() => void) | null): void {
  authExpiredHandler = fn
}

export const api = createApiClient({
  baseUrl,
  getToken: () => tokenStore.get(),
  onUnauthorized: () => {
    tokenStore.clear()
    authExpiredHandler?.()
  },
})
export const captchaEnabled = process.env.NEXT_PUBLIC_CAPTCHA_ENABLED === "true"

/** 共享请求函数类型：各领域 API 封装（library / membership 等）以工厂形式注入复用。 */
export type RequestFn = typeof api.request
