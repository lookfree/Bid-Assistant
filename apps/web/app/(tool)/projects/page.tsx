"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Plus,
  FileSearch,
  ListTree,
  PenLine,
  ShieldAlert,
  Presentation,
  Download,
  CheckCircle2,
  Clock,
  Search,
  Loader2,
  AlertTriangle,
  UploadCloud,
} from "lucide-react"
import { listProjects, setCurrentProjectId, type ProjectListItem } from "@/lib/project"

type CurrentStep = ProjectListItem["currentStep"]

const PAGE_SIZE = 50

// 各步对应的续作入口与展示（export/done 都回正文页，可直接导出）
const stepMap: Record<CurrentStep, { label: string; href: string; tone: string; icon: typeof FileSearch }> = {
  read: { label: "读标中", href: "/read", tone: "gradient-brand-soft text-primary", icon: FileSearch },
  outline: { label: "提纲中", href: "/outline", tone: "gradient-brand-soft text-primary", icon: ListTree },
  content: { label: "正文生成中", href: "/content", tone: "gradient-brand-soft text-primary", icon: PenLine },
  review: { label: "待审查", href: "/risk", tone: "bg-warning/10 text-warning", icon: ShieldAlert },
  present: { label: "述标准备", href: "/present", tone: "gradient-brand-soft text-primary", icon: Presentation },
  export: { label: "待导出", href: "/content", tone: "bg-success/10 text-success", icon: Download },
  done: { label: "已完成", href: "/content", tone: "bg-muted text-muted-foreground", icon: CheckCircle2 },
}

const statusLabel: Record<ProjectListItem["status"], string> = {
  draft: "草稿",
  running: "进行中",
  done: "已完成",
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  // 拉取某页：append=false 为首屏/重试全量替换，append=true 为「加载更多」追加（失败保留已加载数据）
  const fetchPage = useCallback(async (pageNum: number, append: boolean) => {
    const setBusy = append ? setLoadingMore : setLoading
    setBusy(true)
    setError(null)
    try {
      const res = await listProjects(pageNum, PAGE_SIZE)
      setProjects((prev) => (append ? [...prev, ...res.items] : res.items))
      setTotal(res.total)
      setPage(pageNum)
      setHasMore(res.hasMore)
    } catch {
      setError(append ? "加载更多失败，请重试" : "项目列表加载失败，请重试")
    } finally {
      setBusy(false)
    }
  }, [])
  const load = useCallback(() => fetchPage(1, false), [fetchPage])

  useEffect(() => {
    void load()
  }, [load])

  // 状态徽章保鲜：页面重获焦点时静默重拉首页（不置 loading,不闪骨架）——
  // 「正文生成中」这类徽章是快照,用户切去生成页再切回来要看到推进后的状态。
  useEffect(() => {
    const refresh = () => {
      void (async () => {
        try {
          const res = await listProjects(1, PAGE_SIZE)
          setProjects(res.items)
          setTotal(res.total)
          setPage(1)
          setHasMore(res.hasMore)
        } catch {
          /* 静默：保留已展示数据 */
        }
      })()
    }
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  // 搜索：本地按名称过滤（仅已加载部分）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader total={total || projects.length} />
      <OverviewStats projects={projects} total={total} />
      <SearchBox query={query} onQuery={setQuery} />

      {/* 加载 / 失败 */}
      {loading && <ListLoading />}
      {!loading && error && <ErrorBanner error={error} onRetry={() => void load()} />}

      {!loading && !error && projects.length === 0 && <EmptyProjects />}

      {/* 项目列表：自适应填充，宽屏自动多列 */}
      {!loading && filtered.length > 0 && (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}

      {/* 加载更多（有下一页时展示；搜索只作用于已加载部分） */}
      {!loading && hasMore && (
        <LoadMoreButton
          loadingMore={loadingMore}
          loaded={projects.length}
          total={total}
          onClick={() => {
            if (!loadingMore) void fetchPage(page + 1, true)
          }}
        />
      )}

      {/* 有项目但搜索无结果 */}
      {!loading && projects.length > 0 && filtered.length === 0 && (
        <p className="mt-10 text-center text-sm text-muted-foreground">未找到名称包含「{query.trim()}」的项目</p>
      )}
    </div>
  )
}

/* 页头：标题 + 新建入口 */
function PageHeader({ total }: { total: number }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">我的项目</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">共 {total} 个项目，点击任意项目可继续编辑</p>
      </div>
      <Link
        href="/upload"
        className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
      >
        <Plus className="size-4" />
        新建标书
      </Link>
    </div>
  )
}

/* 按名称搜索（本地过滤） */
function SearchBox({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="mt-4 flex max-w-md items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
      <Search className="size-4 text-muted-foreground" />
      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="搜索项目名称"
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
    </div>
  )
}

/* 加载更多按钮：追加下一页 */
function LoadMoreButton({
  loadingMore,
  loaded,
  total,
  onClick,
}: {
  loadingMore: boolean
  loaded: number
  total: number
  onClick: () => void
}) {
  return (
    <div className="mt-5 flex justify-center">
      <button
        onClick={onClick}
        disabled={loadingMore}
        className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        {loadingMore && <Loader2 className="size-4 animate-spin" />}
        {loadingMore ? "加载中…" : `加载更多（已加载 ${loaded}/${total}）`}
      </button>
    </div>
  )
}

/* 首屏加载中占位 */
function ListLoading() {
  return (
    <p className="mt-10 inline-flex w-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      项目加载中…
    </p>
  )
}

/* 加载失败提示 + 重试 */
function ErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
      <AlertTriangle className="size-4 shrink-0 text-destructive" />
      <p className="text-sm text-foreground">{error}</p>
      <button onClick={onRetry} className="ml-auto shrink-0 text-sm font-medium text-primary hover:underline">
        重试
      </button>
    </div>
  )
}

/* 概览统计：全部项目为服务端总数；进行中/已完成仅基于已加载条目（分页未拉全时不声称全量） */
function OverviewStats({ projects, total }: { projects: ProjectListItem[]; total: number }) {
  const loadedAll = projects.length >= total
  const suffix = loadedAll ? "" : "（已加载）"
  const overview: { label: string; value: number; tone: string }[] = [
    { label: "全部项目", value: total || projects.length, tone: "text-foreground" },
    { label: `进行中${suffix}`, value: projects.filter((p) => p.status === "running").length, tone: "text-primary" },
    { label: `已完成${suffix}`, value: projects.filter((p) => p.status === "done").length, tone: "text-success" },
  ]
  return (
    <div className="mt-5 grid grid-cols-3 gap-3">
      {overview.map((s) => (
        <div key={s.label} className="rounded-2xl border border-border bg-card px-4 py-3.5">
          <p className="text-xs text-muted-foreground">{s.label}</p>
          <p className={`mt-1 text-2xl font-semibold ${s.tone}`}>{s.value}</p>
        </div>
      ))}
    </div>
  )
}

/* 空态：引导上传第一份招标文件 */
function EmptyProjects() {
  return (
    <div className="mt-6 flex flex-col items-center rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
        <UploadCloud className="size-7 text-primary" />
      </span>
      <p className="mt-4 text-base font-semibold text-foreground">还没有项目</p>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        上传一份招标文件，AI 将自动完成读标、提纲与正文生成，几分钟得到一本完整标书。
      </p>
      <Link
        href="/upload"
        className="mt-5 inline-flex items-center gap-2 rounded-xl gradient-brand px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
      >
        <Plus className="size-4" />
        上传招标文件，新建标书
      </Link>
    </div>
  )
}

/* 单个项目卡片：点击设为当前项目并跳到对应工具页续作 */
function ProjectCard({ project: p }: { project: ProjectListItem }) {
  const stage = stepMap[p.currentStep] ?? stepMap.read
  const Icon = stage.icon
  const progress = p.totalSteps > 0 ? Math.min(100, Math.round((p.stepIndex / p.totalSteps) * 100)) : 0
  return (
    <Link
      href={stage.href}
      onClick={() => setCurrentProjectId(p.id)}
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
              {p.status === "done" ? statusLabel.done : stage.label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {formatDate(p.createdAt)} 创建
            </span>
            <span>{statusLabel[p.status]}</span>
          </div>
          {/* 进度条：已完成步数 / 总步数 */}
          <div className="mt-2.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full gradient-brand" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs font-medium text-muted-foreground">
              {p.stepIndex}/{p.totalSteps}
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}
