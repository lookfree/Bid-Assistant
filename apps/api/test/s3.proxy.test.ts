import { describe, it, expect, afterAll } from "bun:test"
import { toProxyUrl } from "../src/storage/s3"

// 同源代理改写（2026-07-23 内网访问修复）：纯字符串变换,不触 S3。
describe("toProxyUrl", () => {
  const SIGNED = "http://192.168.106.231:9000/bidsaas/uploads/u/x.docx?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"

  it("设了 MINIO_PROXY_PREFIX → 改写为相对路径,签名查询串原样保留", () => {
    process.env.MINIO_PROXY_PREFIX = "/s3"
    expect(toProxyUrl(SIGNED)).toBe("/s3/bidsaas/uploads/u/x.docx?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc")
  })

  it("未设前缀 → 原样返回（既有部署零变化）", () => {
    delete process.env.MINIO_PROXY_PREFIX
    expect(toProxyUrl(SIGNED)).toBe(SIGNED)
  })

  afterAll(() => {
    delete process.env.MINIO_PROXY_PREFIX
  })
})
