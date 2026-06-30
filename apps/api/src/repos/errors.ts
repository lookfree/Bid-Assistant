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

const IDENTITY_UNIQUE = "user_identities_provider_identifier_uq"

// 唯一冲突 → 领域错误的单一翻译点：只翻译 user_identities 的那一条 UNIQUE，
// 其它唯一冲突（如未来新增约束）原样抛出，避免被误标为“身份已绑定”。
export async function mapIdentityConflict<T>(
  provider: string,
  identifier: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string }
    if (err.code === "23505" && err.constraint_name === IDENTITY_UNIQUE) {
      throw new IdentityAlreadyBoundError(provider, identifier)
    }
    throw e
  }
}
