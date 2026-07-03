import { createHash, createVerify } from "node:crypto"

// 收钱吧两套签名 + 回调验签（架构 §6.0/§6.1）。全部纯函数，网关 HTTP 层（shouqianba.ts）只做拼装。
// ① 非支付接口（激活/签到/查询/退款）：Authorization: <sn> <MD5(body + key)>（激活用 vendor 参数，其余用 terminal）。
// ② 跳转支付（WAP2）：参数 ASCII 升序 k=v& 拼接 + "&key=" + terminal_key 后 MD5，取大写。
// ③ 回调：Authorization 头是对 body 原文的 SHA256WithRSA 签名（Base64），用收钱吧公钥验。

/** 非支付接口 body 签名：MD5(body + key) 小写 hex。 */
export function md5BodySign(body: string, key: string): string {
  return createHash("md5").update(body + key, "utf8").digest("hex")
}

/**
 * WAP2 跳转支付参数签名：剔除 sign/sign_type/空值 → 键 ASCII 升序 `k=v&…` → 追加 `&key=<terminalKey>` → MD5 大写。
 */
export function wap2Sign(params: Record<string, string | undefined>, terminalKey: string): string {
  const canonical = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] != null && params[k] !== "")
    .sort() // JS 默认按 UTF-16 码元升序 = ASCII 升序（参数名均为 ASCII）
    .map((k) => `${k}=${params[k]}`)
    .join("&")
  return createHash("md5").update(`${canonical}&key=${terminalKey}`, "utf8").digest("hex").toUpperCase()
}

/**
 * 回调验签：SHA256WithRSA（body 原文，签名 Base64 在 Authorization 头）。
 * 任何异常（坏公钥/坏 Base64）一律返回 false —— 验签失败只拒绝，不能把 500 泄给回调方。
 */
export function verifyRsaCallback(rawBody: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return createVerify("RSA-SHA256").update(rawBody, "utf8").verify(publicKeyPem, signatureB64, "base64")
  } catch {
    return false
  }
}
