"use client"

import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

/**
 * 流程工具页统一页头（read/outline/content/risk/present/upload 共用）：
 * 渐变图标 + 标题 + 说明 + 右侧插槽（统计条/操作按钮/参数选择等页面自带部件）。
 * 各页原先手写的同构 JSX 收敛到此,防止后续再各改各的长歪。
 */
export function StepPageHeader({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon
  title: string
  desc: string
  /** 右侧部件（可选）：与标题同行,窄屏自动换行 */
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
          <Icon className="size-5 text-white" />
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">{title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">{desc}</p>
        </div>
      </div>
      {children}
    </div>
  )
}
