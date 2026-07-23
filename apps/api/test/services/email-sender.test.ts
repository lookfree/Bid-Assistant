import { describe, it, expect } from "bun:test"
import { createEmailSender, FakeEmailSender } from "../../src/services/email-sender"
import type { Env } from "../../src/config/env"

// 纯单测，不连库；createEmailSender 只读 ALIYUN_DM_* 字段，构造最小 Env 即可。
const mkEnv = (dm: Partial<Env> = {}): Env => ({ ALIYUN_DM_ENDPOINT: "dm.aliyuncs.com", ...dm }) as Env

describe("email-sender：DirectMail 凭据缺失回退 Fake", () => {
  it("无 DM 凭据 → FakeEmailSender（不真发）", () => {
    expect(createEmailSender(mkEnv())).toBeInstanceOf(FakeEmailSender)
  })

  it("缺发信地址（只有 key/secret）→ 仍回退 Fake", () => {
    expect(createEmailSender(mkEnv({ ALIYUN_DM_ACCESS_KEY_ID: "k", ALIYUN_DM_ACCESS_KEY_SECRET: "s" }))).toBeInstanceOf(FakeEmailSender)
  })

  it("凭据齐全（key+secret+发信地址）→ 非 Fake（真发客户端）", () => {
    const env = mkEnv({ ALIYUN_DM_ACCESS_KEY_ID: "k", ALIYUN_DM_ACCESS_KEY_SECRET: "s", ALIYUN_DM_ACCOUNT_NAME: "noreply@mail.example.com" })
    expect(createEmailSender(env)).not.toBeInstanceOf(FakeEmailSender)
  })
})
