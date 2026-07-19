// crypto.randomUUID() 仅在安全上下文（HTTPS / http://localhost）可用；纯 HTTP 部署下它 undefined，
// 直接调用会抛错。此处降级到 crypto.getRandomValues（HTTP 下可用）拼一个符合规范的 UUIDv4，
// 保证后台在 HTTP 环境下的幂等键/临时 id 生成不失败（加积分/退款/新增模型均依赖）。
export function safeUUID(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}
