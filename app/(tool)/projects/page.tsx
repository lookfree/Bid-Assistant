"use client"

import Link from "next/link"
import {
  Plus,
  FileSearch,
  ListTree,
  PenLine,
  ShieldAlert,
  Download,
  Clock,
  Search,
  MoreHorizontal,
} from "lucide-react"
import { projectMeta } from "@/lib/sample-bid"

type Stage = "read" | "outline" | "content" | "risk" | "export" | "done"

const stageMap: Record<Stage, { label: string; href: string; tone: string }> = {
  read: { label: "读标中", href: "/read", tone: "gradient-brand-soft text-primary" },
  outline: { label: "提纲中", href: "/outline", tone: "gradient-brand-soft text-primary" },
  content: { label: "正文生成中", href: "/content", tone: "gradient-brand-soft text-primary" },
  risk: { label: "待审查", href: "/risk", tone: "bg-warning/10 text-warning" },
  export: { label: "待导出", href: "/content", tone: "bg-success/10 text-success" },
  done: { label: "已交付", href: "/content", tone: "bg-muted text-muted-foreground" },
}

/** 概览统计分组：进行中（读标/提纲/正文）· 待审查 · 待导出 · 已交付 */
type StatGroup = "active" | "risk" | "export" | "done"
const statGroupOf = (s: Stage): StatGroup =>
  s === "read" || s === "outline" || s === "content" ? "active" : (s as StatGroup)

const projects: { id: string; name: string; stage: Stage; updated: string; deadline: string; progress: number }[] = [
  {
    id: "1",
    name: projectMeta.name,
    stage: "risk",
    updated: "10 分钟前",
    deadline: "7 天后截止",
    progress: 82,
  },
  {
    id: "2",
    name: "市政道路养护服务采购项目",
    stage: "content",
    updated: "2 小时前",
    deadline: "6 天后截止",
    progress: 56,
  },
  {
    id: "3",
    name: "中学智慧校园设备采购",
    stage: "export",
    updated: "昨天",
    deadline: "9 天后截止",
    progress: 95,
  },
  {
    id: "4",
    name: "某医院信息系统集成项目",
    stage: "done",
    updated: "3 天前",
    deadline: "已投递",
    progress: 100,
  },
]

const stageIcon: Record<Stage, typeof FileSearch> = {
  read: FileSearch,
  outline: ListTree,
  content: PenLine,
  risk: ShieldAlert,
  export: Download,
  done: Download,
}

export default function ProjectsPage() {
  const stats = {
    active: projects.filter((p) => statGroupOf(p.stage) === "active").length,
    risk: projects.filter((p) => statGroupOf(p.stage) === "risk").length,
    export: projects.filter((p) => statGroupOf(p.stage) === "export").length,
    done: projects.filter((p) => statGroupOf(p.stage) === "done").length,
  }
  const overview: { label: string; value: number; tone: string }[] = [
    { label: "进行中", value: stats.active, tone: "text-primary" },
    { label: "待审查", value: stats.risk, tone: "text-warning" },
    { label: "待导出", value: stats.export, tone: "text-success" },
    { label: "已交付", value: stats.done, tone: "text-foreground" },
  ]

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">我的项目</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">共 {projects.length} 个项目，点击任意项目可继续编辑</p>
        </div>
        <Link
          href="/upload"
          className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" />
          新建标书
        </Link>
      </div>

      {/* 概览统计 */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {overview.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card px-4 py-3.5">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* 搜索 */}
      <div className="mt-4 flex max-w-md items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
        <Search className="size-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="搜索项目名称"
          className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      {/* 项目列表：自适应填充，宽屏自动多列 */}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {projects.map((p) => {
          const stage = stageMap[p.stage]
          const Icon = stageIcon[p.stage]
          return (
            <Link
              key={p.id}
              href={stage.href}
              className="group rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
            >
              <div className="flex items-start gap-3.5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground group-hover:gradient-brand group-hover:text-white">
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${stage.tone}`}>
                      {stage.label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3.5" />
                      {p.updated}更新
                    </span>
                    <span>{p.deadline}</span>
                  </div>
                  {/* 进度条 */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full gradient-brand" style={{ width: `${p.progress}%` }} />
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">{p.progress}%</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted"
                  aria-label="更多操作"
                  onClick={(e) => e.preventDefault()}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
