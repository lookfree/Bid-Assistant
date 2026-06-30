import { describe, it, expect } from "bun:test"
import { parseEnv } from "../src/config/env"

describe("parseEnv", () => {
  it("throws when DATABASE_URL missing", () => {
    expect(() => parseEnv({ PORT: "8080" })).toThrow()
  })
  it("parses valid env with defaults", () => {
    const env = parseEnv({ DATABASE_URL: "postgresql://u:p@h:5432/d" })
    expect(env.DATABASE_URL).toBe("postgresql://u:p@h:5432/d")
    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe("development")
  })
})
