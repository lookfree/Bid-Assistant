import { describe, it, expect } from "bun:test"
import { createTokenStore } from "../lib/token-store"

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("token-store", () => {
  it("set/get/clear", () => {
    const s = createTokenStore(memStorage())
    expect(s.get()).toBeNull()
    s.set("tok-123")
    expect(s.get()).toBe("tok-123")
    s.clear()
    expect(s.get()).toBeNull()
  })
})
