import { describe, it, expect } from "bun:test"
import {
  AliyunCaptchaVerifier,
  DevPassCaptchaVerifier,
  createCaptchaVerifier,
  type IntelligentCaptchaClient,
} from "../../src/services/captcha"
import { parseEnv } from "../../src/config/env"

// 最小合法 env（parseEnv 必填项）+ 可覆盖的 captcha 相关字段
const mkEnv = (o: Record<string, string | undefined> = {}) =>
  parseEnv({
    DATABASE_URL: "postgresql://u:p@h:5432/d",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "test-access-key",
    MINIO_SECRET_KEY: "test-secret-key",
    ...o,
  })

class FakeClient implements IntelligentCaptchaClient {
  calls = 0
  constructor(private result: boolean | (() => Promise<{ verifyResult: boolean }>)) {}
  async verifyIntelligentCaptcha(): Promise<{ verifyResult: boolean }> {
    this.calls++
    if (typeof this.result === "function") return this.result()
    return { verifyResult: this.result }
  }
}

describe("AliyunCaptchaVerifier", () => {
  it("fake 返回 verifyResult:true -> verify(param) 为 true", async () => {
    const client = new FakeClient(true)
    const v = new AliyunCaptchaVerifier(client, "scene-1")
    expect(await v.verify("param")).toBe(true)
    expect(client.calls).toBe(1)
  })

  it("fake 返回 verifyResult:false -> false", async () => {
    const client = new FakeClient(false)
    const v = new AliyunCaptchaVerifier(client, "scene-1")
    expect(await v.verify("param")).toBe(false)
  })

  it("fake 抛异常 -> false（fail-closed），异常不冒出", async () => {
    const client: IntelligentCaptchaClient = {
      async verifyIntelligentCaptcha() {
        throw new Error("network down")
      },
    }
    const v = new AliyunCaptchaVerifier(client, "scene-1")
    await expect(v.verify("param")).resolves.toBe(false)
  })

  it("verify(undefined)/verify('') -> false，且不调用阿里云", async () => {
    const client = new FakeClient(true)
    const v = new AliyunCaptchaVerifier(client, "scene-1")
    expect(await v.verify(undefined)).toBe(false)
    expect(await v.verify("")).toBe(false)
    expect(client.calls).toBe(0)
  })
})

describe("createCaptchaVerifier 工厂", () => {
  it("有三个凭据 -> 返回 AliyunCaptchaVerifier 实例，不再抛", () => {
    const env = mkEnv({
      ALIYUN_CAPTCHA_ACCESS_KEY_ID: "ak-id",
      ALIYUN_CAPTCHA_ACCESS_KEY_SECRET: "ak-secret",
      ALIYUN_CAPTCHA_SCENE_ID: "scene-1",
    })
    const v = createCaptchaVerifier(env)
    expect(v).toBeInstanceOf(AliyunCaptchaVerifier)
  })

  it("无凭据 + 非生产 -> DevPassCaptchaVerifier（回归）", () => {
    const env = mkEnv({ NODE_ENV: "development" })
    const v = createCaptchaVerifier(env)
    expect(v).toBeInstanceOf(DevPassCaptchaVerifier)
  })

  it("无凭据 + 生产 + CAPTCHA_ENABLED=true -> 抛（回归）", () => {
    const env = mkEnv({ NODE_ENV: "production", CAPTCHA_ENABLED: "true" })
    expect(() => createCaptchaVerifier(env)).toThrow()
  })
})
