"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Hourglass } from "lucide-react"

/** 真实项目该步 / 前序步数据未就绪时的面板占位（真实模式不回落示例内容）。 */
export function StepPlaceholder({
  text,
  action,
  delayMs = 0,
}: {
  text: string
  /** 可选引导入口（如「前往提纲页」） */
  action?: { href: string; label: string }
  /** 延迟显现毫秒数：快请求（几百 ms 内返回）期间什么都不渲染，避免"闪一下加载提示"。 */
  delayMs?: number
}) {
  const [show, setShow] = useState(delayMs === 0)
  useEffect(() => {
    if (delayMs === 0) return
    const t = setTimeout(() => setShow(true), delayMs)
    return () => clearTimeout(t)
  }, [delayMs])
  if (!show) return null
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
