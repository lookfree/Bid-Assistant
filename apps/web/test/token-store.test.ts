import { describe, it, expect } from "bun:test"
import { createTokenStore, memoryStorage } from "../lib/token-store"

describe("token-store", () => {
  it("set/get/clear", () => {
    const s = createTokenStore(memoryStorage())
    expect(s.get()).toBeNull()
    s.set("tok-123")
    expect(s.get()).toBe("tok-123")
    s.clear()
    expect(s.get()).toBeNull()
  })
})
