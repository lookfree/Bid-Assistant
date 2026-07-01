import { createApiClient } from "./api-client"
import { tokenStore } from "./token-store"

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080"
export const api = createApiClient({ baseUrl, getToken: () => tokenStore.get() })
export const captchaEnabled = process.env.NEXT_PUBLIC_CAPTCHA_ENABLED === "true"
