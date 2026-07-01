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

// 浏览器用 localStorage；SSR/缺失时退化为内存（避免 import 期崩）
function safeStorage(): SimpleStorage {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

export const tokenStore = createTokenStore(safeStorage())
