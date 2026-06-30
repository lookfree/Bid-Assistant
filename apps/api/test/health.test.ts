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

describe("GET /readyz", () => {
  it("returns 200 when db reachable", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/readyz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ready", db: "up" })
  })
  it("returns 503 when db unreachable", async () => {
    const app = createApp({ pingDb: async () => false })
    const res = await app.request("/readyz")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "unready", db: "down" })
  })
})
