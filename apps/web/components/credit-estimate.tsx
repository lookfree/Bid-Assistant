"use client"

import Link from "next/link"
import { Coins, AlertCircle, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

interface CreditEstimateProps {
  /** 本次操作预计消耗的积分 */
  cost: number
  /** 当前积分余额（真实值，由调用方经 useMembership 提供） */
  balance: number
  /** 估算可支持的单位词，如「章」「次」「份」 */
  unitLabel?: string
  /** 是否展示「约可支持 N 单位」一行 */
  showSupportable?: boolean
  /** 确认按钮文案 */
  actionLabel?: string
  /** 点击确认回调（余额充足时可用） */
  onConfirm?: () => void
  className?: string
}

/**
 * 可复用的积分预估确认条。
 * 在任何 AI 付费操作（读标 / 提纲 / 生成本章 / 重写 / 废标体检 / 查重 / 导出）触发前展示：
 * 「本次预计消耗 X 积分 · 当前余额 YY · 约可支持 N 章」。
 * 余额不足时按钮置灰并引导去充值 / 升级。
 */
export function CreditEstimate({
  cost,
  balance,
  unitLabel = "次",
  showSupportable = true,
  actionLabel = "确认并继续",
  onConfirm,
  className,
}: CreditEstimateProps) {
  const enough = balance >= cost
  const supportable = cost > 0 ? Math.floor(balance / cost) : 0

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between",
        enough ? "border-border" : "border-[oklch(0.85_0.08_60)] bg-[oklch(0.98_0.02_75)]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            enough ? "bg-[oklch(0.96_0.06_85)] text-[oklch(0.55_0.13_75)]" : "bg-[oklch(0.95_0.06_60)] text-[oklch(0.5_0.14_55)]",
          )}
        >
          {enough ? <Coins className="size-5" /> : <AlertCircle className="size-5" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            本次预计消耗 <span className="font-bold text-primary">{cost}</span> 积分
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            当前余额 {balance.toLocaleString()} 积分
            {showSupportable && enough && (
              <>
                {" · "}约可支持 {supportable} {unitLabel}
              </>
            )}
            {!enough && <span className="text-[oklch(0.5_0.14_55)]"> · 余额不足，无法继续</span>}
          </p>
        </div>
      </div>

      {enough ? (
        <button
          type="button"
          onClick={onConfirm}
          className="shrink-0 rounded-lg gradient-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          {actionLabel}
        </button>
      ) : (
        <Link
          href="/membership"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg gradient-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          去充值 / 升级
          <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  )
}
