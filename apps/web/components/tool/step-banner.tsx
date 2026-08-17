"use client"

import Link from "next/link"
import { Loader2 } from "lucide-react"

// 各工具页共用的「步骤运行中 / 失败重试」横幅（/read /outline /content /present）。
export function StepBanner({
  running,
  error,
  runningText,
  progress,
  overallPct,
  remainSeconds,
  onRetry,
  action,
}: {
  running: boolean
  error: string | null
  runningText: string
  /** 当前阶段的完成度（服务端结构化下发的 done/total）。给了就画进度条，没给只显示文案。 */
  progress?: { done: number; total: number } | null
  /** **整步**进度百分比（2026-08-17 用户口径：100% 是整个任务的）。给了就优先于 progress。 */
  overallPct?: number | null
  /** 预计剩余秒数；null=估不准/已超出预估，显示「即将完成」而不是负数或假精度。 */
  remainSeconds?: number | null
  onRetry: () => void
  /** 失败时的引导链接（如 402 积分不足 → 去充值），有则替代「重试」按钮 */
  action?: { href: string; label: string }
}) {
  // 百分比夹在 0–100：done/total 来自服务端，续跑复用等情形下不该因为一次异常计数就画出 137%。
  // 整步百分比优先（它已经把各阶段区间算进去了）；没有才退回「当前阶段完成度」。
  const pct = overallPct != null
    ? Math.min(100, Math.max(0, Math.round(overallPct)))
    : progress && progress.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
      : null
  // 「还需约 N 分钟」：不足 1 分钟说「不到 1 分钟」，超出预估说「即将完成」——
  // 绝不显示秒级倒计时（估不到那个精度，显示了就是骗人）。
  const remainText = overallPct == null
    ? null
    : remainSeconds == null
      ? "即将完成"
      : remainSeconds < 60
        ? "预计还需不到 1 分钟"
        : `预计还需约 ${Math.round(remainSeconds / 60)} 分钟`
  if (running)
    return (
      <div className="mb-4 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 text-sm font-medium text-primary">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1">{runningText}</span>
          {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
        </div>
        {remainText && <div className="mt-1 pl-6 text-xs text-primary/70">{remainText}</div>}
        {/* 进度条是**整步**完成度（2026-08-17 用户口径）：各阶段由服务端声明自己在整步里的
            百分比区间（publish_phase 的 span），有真实分母就按分母定位、没有就按预估时间在
            自己的区间内插值且封顶区间末——100% 只在整步真的结束时才给。 */}
        {pct !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
            <div className="h-full rounded-full gradient-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    )
  if (error)
    return (
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <span>{error}</span>
        {action ? (
          <Link href={action.href} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
            {action.label}
          </Link>
        ) : (
          <button onClick={onRetry} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
            重试
          </button>
        )}
      </div>
    )
  return null
}
