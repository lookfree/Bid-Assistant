import { createApiClient } from "./api-client"
import { tokenStore } from "./token-store"

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080"

// 令牌失效事件：任意请求 401 时清令牌并广播，AuthProvider 收到后复位登录态、守卫跳登录。
export const AUTH_EXPIRED_EVENT = "bid:auth-expired"

export const api = createApiClient({
  baseUrl,
  getToken: () => tokenStore.get(),
  onUnauthorized: () => {
    tokenStore.clear()
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  },
})
export const captchaEnabled = process.env.NEXT_PUBLIC_CAPTCHA_ENABLED === "true"
