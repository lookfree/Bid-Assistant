import { describe, it, expect } from "bun:test"
import { createAdminTokenStore } from "../lib/admin-token-store"

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("spec309 admin-token-store", () => {
  it("set/get/clear，且 key 与 C 端隔离", () => {
    const s = memStorage()
    const store = createAdminTokenStore(s)
    expect(store.get()).toBeNull()
    store.set("adm-token")
    expect(store.get()).toBe("adm-token")
    // 隔离：不得使用 C 端 key 'bid.token'
    expect(s.getItem("bid.token")).toBeNull()
    expect(s.getItem("bid.admin.token")).toBe("adm-token")
    store.clear()
    expect(store.get()).toBeNull()
  })
})
