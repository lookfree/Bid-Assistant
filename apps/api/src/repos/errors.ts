// 身份（手机号/微信等）已被占用：UNIQUE(provider, identifier) 冲突的领域化表达，
// 让调用方能区分“已绑定”与真实故障，返回干净的业务结果而非 500。
export class IdentityAlreadyBoundError extends Error {
  constructor(
    public provider: string,
    public identifier: string,
  ) {
    super(`身份已被绑定: ${provider}/${identifier}`)
    this.name = "IdentityAlreadyBoundError"
  }
}

// Postgres 唯一约束冲突错误码（postgres-js 把它放在 error.code 上）。
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505"
}
