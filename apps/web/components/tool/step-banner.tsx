"use client"

import { Loader2 } from "lucide-react"

// 各工具页共用的「步骤运行中 / 失败重试」横幅（/read /outline /content /present）。
export function StepBanner({
  running,
  error,
  runningText,
  onRetry,
}: {
  running: boolean
  error: string | null
  runningText: string
  onRetry: () => void
}) {
  if (running)
    return (
      <div className="mb-4 flex items-center gap-2 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 text-sm font-medium text-primary">
        <Loader2 className="size-4 animate-spin" />
        {runningText}
      </div>
    )
  if (error)
    return (
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <span>{error}</span>
        <button onClick={onRetry} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
          重试
        </button>
      </div>
    )
  return null
}
