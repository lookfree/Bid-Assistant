import { createHash } from "node:crypto"

// token 入库前的 sha256 十六进制哈希：C 端 sessions 与 admin sessions 共用同一算法，
// 避免两处各写一份、日后一侧改算法导致既有会话无法验证（漂移）。
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}
