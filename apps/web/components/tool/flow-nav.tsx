"use client"

import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"

/** 线性编标流程顺序 */
const FLOW = [
  { key: "upload", label: "新建标书", href: "/upload" },
  { key: "read", label: "招标解读", href: "/read" },
  { key: "outline", label: "提纲生成", href: "/outline" },
  { key: "content", label: "标书生成", href: "/content" },
  { key: "risk", label: "标书审查", href: "/risk" },
  { key: "present", label: "述标演示", href: "/present" },
] as const

export type FlowStep = (typeof FLOW)[number]["key"]

/**
 * 线性流程返回区：左侧「上一步」按钮 + 当前步骤面包屑。
 * 面包屑展示从起点到当前步骤的路径，历史步骤可点击跳转，移动端可横向滚动。
 */
export function FlowNav({ current }: { current: FlowStep }) {
  const index = FLOW.findIndex((s) => s.key === current)
  const prev = index > 0 ? FLOW[index - 1] : null
  const trail = FLOW.slice(0, index + 1)

  return (
    <nav
      aria-label="流程导航"
      className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
    >
      {prev && (
        <Link
          href={prev.href}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <ChevronLeft className="size-3.5" />
          上一步
        </Link>
      )}
      <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {trail.map((s, i) => {
          const isCurrent = s.key === current
          return (
            <li key={s.key} className="flex shrink-0 items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              {isCurrent ? (
                <span className="font-semibold text-foreground" aria-current="step">
                  {s.label}
                </span>
              ) : (
                <Link href={s.href} className="text-muted-foreground transition-colors hover:text-foreground">
                  {s.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
