"use client"

import { Sparkles } from "lucide-react"

/**
 * 计费步骤的显式生成入口（read/outline/risk 等页共用）：
 * 计费步一律由用户点击触发、点击前明示消耗积分数，绝不自动串跑。
 */
export function StepRunCta({
  title,
  desc,
  costText,
  actionLabel,
  onRun,
}: {
  title: string
  desc?: string
  /** 消耗口径文案，如「消耗 30 积分」「40 积分/章起」 */
  costText: string
  actionLabel: string
  onRun: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl gradient-brand-soft">
        <Sparkles className="size-6 text-primary" />
      </span>
      <p className="text-base font-semibold text-foreground">{title}</p>
      {desc && <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{desc}</p>}
      <button
        onClick={onRun}
        className="mt-2 inline-flex items-center gap-2 rounded-xl gradient-brand px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
      >
        <Sparkles className="size-4" />
        {actionLabel}（{costText}）
      </button>
    </div>
  )
}
