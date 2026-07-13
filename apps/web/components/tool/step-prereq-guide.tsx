"use client"

import Link from "next/link"
import { ListTodo } from "lucide-react"

/**
 * 前序步骤未完成时的流程引导卡（content/risk 页已接入；其余步骤页按需采用）：
 * 渲染时就主动判断前序缺口（stepPrereq），给出"流程走到哪、下一步去哪"的正向引导——
 * 而不是先亮出本步的计费按钮、等用户点了再报 409"步骤顺序不符"（生硬且像报错）。
 */
export function StepPrereqGuide({
  prereq,
  currentDesc,
}: {
  /** 未完成的前序步入口（stepPrereq 的返回值） */
  prereq: { href: string; label: string }
  /** 本步说明，如「投标正文需要基于提纲章节结构撰写」 */
  currentDesc: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl gradient-brand-soft">
        <ListTodo className="size-6 text-primary" />
      </span>
      <p className="text-base font-semibold text-foreground">先完成「{prereq.label}」</p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{currentDesc}</p>
      <Link
        href={prereq.href}
        className="mt-1 inline-flex items-center rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
      >
        前往{prereq.label}
      </Link>
    </div>
  )
}
