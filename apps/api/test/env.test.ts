import { describe, it, expect } from "bun:test"
import { parseEnv } from "../src/config/env"

describe("parseEnv", () => {
  it("throws when DATABASE_URL missing", () => {
    expect(() => parseEnv({ PORT: "8080" })).toThrow()
  })
  it("parses valid env with defaults", () => {
    // MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY 为必填（无 default），最小合法集需带上（spec006）。
    const env = parseEnv({
      DATABASE_URL: "postgresql://u:p@h:5432/d",
      MINIO_ENDPOINT: "http://localhost:9000",
      MINIO_ACCESS_KEY: "test-access-key",
      MINIO_SECRET_KEY: "test-secret-key",
    })
    expect(env.DATABASE_URL).toBe("postgresql://u:p@h:5432/d")
    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe("development")
    expect(env.MINIO_BUCKET).toBe("bidsaas")
  })
})
