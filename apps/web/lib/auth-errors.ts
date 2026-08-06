import { ApiError } from "./api-client"

// 后端 error code → 用户文案（ApiError.code = 响应体 error 字段）。集中一处，send/verify/未来调用方共用，
// 与后端错误词表保持单一来源，避免各页面各自重写、漂移。
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_phone: "手机号格式不正确",
  captcha_required: "请先完成人机验证",
  terms_required: "请先同意《用户协议》和《隐私政策》后再登录",
  invalid_input: "手机号或验证码格式有误",
  // 三种情况必须分开说。合成一句「验证码错误或已过期」的话，输错一位的用户会被告知"已过期"，
  // 而码明明还在有效期内——用户只会认定系统在骗人（2026-08-06 反馈）。
  invalid_code: "验证码不正确，请核对后重新输入",
  code_expired: "验证码已失效，请重新获取",
  code_too_many_attempts: "验证码输错次数过多，已失效，请重新获取",
  account_banned: "该账号已被封禁，如有疑问请联系客服",
}

// 按 error code 取文案；429 特判带上重试秒数；其余回退到调用方给的兜底文案。
export function authErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return `操作过于频繁，请 ${e.retryAfter ?? 60}s 后重试`
    if (e.code) {
      const msg = AUTH_ERROR_MESSAGES[e.code]
      if (msg) return msg
    }
  }
  return fallback
}
