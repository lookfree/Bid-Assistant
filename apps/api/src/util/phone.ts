// 归一化为 E.164（以中国大陆为主）：去空白/连字符、统一 +86 前缀，
// 使 "+8613..." / "8613..." / "13..." 映射到同一身份键、限流键与短信目标，
// 避免同号不同写法造成账号重复或限流绕过。
export function normalizePhone(raw: string): string {
  let s = raw.replace(/[\s-]/g, "")
  if (s.startsWith("00")) s = s.slice(2) // 国际接入码 00 → 去掉
  s = s.replace(/^\+/, "")
  if (/^1\d{10}$/.test(s)) s = "86" + s // 中国大陆裸 11 位手机号 → 补国家码
  return "+" + s
}
