// admin 令牌存储（spec309）：key 与 C 端 'bid.token' 完全隔离，运营后台独立登录态。
type SimpleStorage = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

const KEY = "bid.admin.token" // 与 C 端 'bid.token' 完全隔离

export function createAdminTokenStore(storage: SimpleStorage) {
  return {
    get: (): string | null => storage.getItem(KEY),
    set: (token: string): void => storage.setItem(KEY, token),
    clear: (): void => storage.removeItem(KEY),
  }
}

function safeStorage(): SimpleStorage {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

export const adminTokenStore = createAdminTokenStore(safeStorage())
