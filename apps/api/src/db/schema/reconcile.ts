import { pgTable, uuid, text, index, uniqueIndex, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, createdAt } from "./columns"

// 对账差异表（spec306）：每行一笔对不上的账，人工/退款流程处置。
// order_id/user_id 不设 FK——差异记录是审计凭据，必须可比订单/用户活得久（删用户不连坐删差异）。
export const reconcileDiffs = pgTable(
  "reconcile_diffs",
  {
    id: id(),
    billDate: text("bill_date").notNull(), // 首次检出的对账日 YYYY-MM-DD（UTC 窗口）
    // amount_mismatch(金额不符) | status_mismatch(状态不符) | unknown_paid(本地未知而通道已付★最高优先)
    // | provider_missing(本地已结算而通道查无) | ledger_mismatch(缓存余额≠Σ流水)
    // | orphan_hold(超时无了结的冻结预扣) | refund_stuck(退款卡在 pending，通道结果不明)
    diffType: text("diff_type").notNull(),
    // 去重主体：订单类=tradeNo/clientSn、账本类=userId、孤儿 hold=holdId、退款类=refundId。
    // 同 (类型,主体) 的 open 差异只保留一行（持久问题不逐日重复落），人工 resolve 后再次检出才开新行。
    subject: text("subject").notNull(),
    tradeNo: text("trade_no"), // 收钱吧 sn / 渠道单号（账本审计类为空）
    orderId: uuid("order_id"), // 关联本地订单（单边账/账本类可空）
    userId: uuid("user_id"), // 账本审计/孤儿 hold 记 user
    localValue: text("local_value"), // 本地侧值（金额/状态/缓存余额/holdId）
    billValue: text("bill_value"), // 通道/账本侧值（金额/状态/Σ流水）
    resolved: text("resolved").notNull().default("open"), // 人工处置后置 resolved
    createdAt: createdAt(),
  },
  (t) => ({
    dateIdx: index("reconcile_diffs_date_idx").on(t.billDate),
    openIdx: index("reconcile_diffs_open_idx").on(t.resolved), // 运营后台扫 open（spec310）
    // DB 层幂等兜底：并发跑对账（cron + 手动触发）也不会双记同一差异
    openSubjectUq: uniqueIndex("reconcile_diffs_open_subject_uq").on(t.diffType, t.subject).where(sql`${t.resolved} = 'open'`),
    typeCheck: check(
      "reconcile_diffs_type_check",
      sql`${t.diffType} in ('amount_mismatch','status_mismatch','unknown_paid','provider_missing','ledger_mismatch','orphan_hold','refund_stuck')`,
    ),
    resolvedCheck: check("reconcile_diffs_resolved_check", sql`${t.resolved} in ('open','resolved')`),
  }),
)
