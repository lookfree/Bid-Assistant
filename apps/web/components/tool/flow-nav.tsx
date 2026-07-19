"use client"

import Link from "next/link"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { currentProjectId, peekProjectCache, type ProjectInfo } from "@/lib/project"

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

// 服务端步骤名 → 流程页 key（review 步的页面是 /risk；export 在 content 页内,归到 content）
const STEP_TO_FLOW: Record<string, FlowStep> = {
  read: "read", outline: "outline", content: "content",
  review: "risk", present: "present", export: "content",
}

/**
 * 线性流程返回区：左侧「上一步」按钮 + 当前步骤面包屑。
 * 面包屑展示从起点到当前步骤的路径，历史步骤可点击跳转，移动端可横向滚动。
 * 传入 info 时,若有步骤正在服务端运行,右侧常驻「XX进行中」指示（含跳转）——
 * 用户切到任何流程页都能看到在途任务,不会因离开生成页而「感觉流程断了」。
 */
export function FlowNav({ current, info }: { current: FlowStep; info?: ProjectInfo | null }) {
  const index = FLOW.findIndex((s) => s.key === current)
  const prev = index > 0 ? FLOW[index - 1] : null
  const trail = FLOW.slice(0, index + 1)
  // 页面没传 info（如 risk 页顶层无 useStep）时退化为读项目缓存快照——指示器精度要求不高,
  // 缓存过期/未命中就不显示,不为它多发请求。
  const pid = typeof window !== "undefined" ? currentProjectId() : null
  const effective = info ?? (pid ? peekProjectCache(pid) : null)
  const runningRow = effective?.steps.find((s) => s.status === "running")
  const runningFlow = runningRow ? FLOW.find((f) => f.key === STEP_TO_FLOW[runningRow.step]) : null

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
      {runningFlow && (
        <Link
          href={runningFlow.href}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
        >
          <Loader2 className="size-3.5 animate-spin" />
          {runningFlow.label}进行中
        </Link>
      )}
    </nav>
  )
}
