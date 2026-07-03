import { describe, it, expect } from "bun:test"
import { createHash, generateKeyPairSync, createSign } from "node:crypto"
import { md5BodySign, wap2Sign, verifyRsaCallback } from "../src/services/payment/shouqianba-sign"

// 收钱吧两套签名 + 回调 RSA 验签（架构 §6.0/§6.1，spec304 Task 1）。
// 纯函数、不打网络；向量用 MD5 已知值 + 测试内自签 RSA 密钥对。

describe("md5BodySign（非支付接口：Authorization = sn + ' ' + MD5(body+key)）", () => {
  it("输出 = MD5(body+key) 的小写 hex", () => {
    // MD5("abc") = 900150983cd24fb0d6963f7d28e17f72（RFC 1321 已知向量）
    expect(md5BodySign("ab", "c")).toBe("900150983cd24fb0d6963f7d28e17f72")
  })

  it("真实形态：JSON body + vendor_key", () => {
    const body = '{"app_id":"appid","code":"00000000","device_id":"dev-1"}'
    const expected = createHash("md5").update(body + "vkey123", "utf8").digest("hex")
    expect(md5BodySign(body, "vkey123")).toBe(expected)
  })
})

describe("wap2Sign（跳转支付：ASCII 升序 k=v&… + &key=terminalKey 的 MD5 大写）", () => {
  it("按键 ASCII 升序拼接并大写 MD5", () => {
    const sign = wap2Sign(
      { total_amount: "1", client_sn: "abc", terminal_sn: "SN1" },
      "tk",
    )
    const canonical = "client_sn=abc&terminal_sn=SN1&total_amount=1&key=tk"
    expect(sign).toBe(createHash("md5").update(canonical, "utf8").digest("hex").toUpperCase())
  })

  it("剔除 sign/sign_type 与空值参数", () => {
    const sign = wap2Sign(
      { b: "2", a: "1", sign: "SHOULD_DROP", sign_type: "MD5", empty: "", omitted: undefined },
      "tk",
    )
    const canonical = "a=1&b=2&key=tk"
    expect(sign).toBe(createHash("md5").update(canonical, "utf8").digest("hex").toUpperCase())
  })
})

describe("verifyRsaCallback（回调：Authorization 带 Base64 签名，body 原文为被签内容，SHA256WithRSA）", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const signOf = (body: string) => createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64")

  it("自签自验通过", () => {
    const body = '{"client_sn":"o-1","order_status":"PAID","sn":"780000","trade_no":"wx123"}'
    expect(verifyRsaCallback(body, signOf(body), publicPem)).toBe(true)
  })

  it("篡改 body 验签失败", () => {
    const body = '{"client_sn":"o-1","total_amount":"1"}'
    const tampered = '{"client_sn":"o-1","total_amount":"100"}'
    expect(verifyRsaCallback(tampered, signOf(body), publicPem)).toBe(false)
  })

  it("垃圾签名/坏公钥不抛错，只返回 false（验签失败一律拒绝，不 500）", () => {
    expect(verifyRsaCallback("{}", "not-base64!!!", publicPem)).toBe(false)
    expect(verifyRsaCallback("{}", signOf("{}"), "-----BEGIN PUBLIC KEY-----\nbroken\n-----END PUBLIC KEY-----")).toBe(false)
  })
})
