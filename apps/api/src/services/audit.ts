import { getDb } from "../db/client"
import { adminAuditLogs } from "../db/schema"

// 敏感操作审计装置（spec309）：spec310 所有写操作末尾调用，留前后值（架构 §3.3）。
export async function writeAudit(input: {
  operator: string // admin username
  action: string // 如 refund.approve / credit.adjust / user.ban
  target?: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  await getDb()
    .insert(adminAuditLogs)
    .values({
      operator: input.operator,
      action: input.action,
      target: input.target ?? null,
      before: (input.before ?? null) as never,
      after: (input.after ?? null) as never,
    })
}
