import { describe, it, expect } from "bun:test"
import { createApp } from "../src/app"

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})
