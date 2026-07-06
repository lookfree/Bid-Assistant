"use client"

import Link from "next/link"
import { Hourglass } from "lucide-react"

/** 真实项目该步 / 前序步数据未就绪时的面板占位（真实模式不回落示例内容）。 */
export function StepPlaceholder({
  text,
  action,
}: {
  text: string
  /** 可选引导入口（如「前往提纲页」） */
  action?: { href: string; label: string }
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted">
        <Hourglass className="size-5 text-muted-foreground" />
      </span>
      <p className="text-sm text-muted-foreground">{text}</p>
      {action && (
        <Link href={action.href} className="text-sm font-semibold text-primary underline">
          {action.label}
        </Link>
      )}
    </div>
  )
}
