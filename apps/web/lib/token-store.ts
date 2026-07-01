export type SimpleStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = "bid.token"

export function createTokenStore(storage: SimpleStorage) {
  return {
    get: (): string | null => storage.getItem(KEY),
    set: (token: string): void => storage.setItem(KEY, token),
    clear: (): void => storage.removeItem(KEY),
  }
}

// 浏览器用 localStorage；SSR/缺失/被禁用时退化为内存（避免 import 期崩）。
// 注意：隐私模式/沙箱 iframe 下 window.localStorage 存在但读写会抛 SecurityError，故用探测确认可用。
function safeStorage(): SimpleStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const probe = "__bid_probe__"
      window.localStorage.setItem(probe, "1")
      window.localStorage.removeItem(probe)
      return window.localStorage
    }
  } catch {
    // localStorage 存在但访问抛错 → 落到内存实现
  }
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

export const tokenStore = createTokenStore(safeStorage())
