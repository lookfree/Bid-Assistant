"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  FileText,
  Briefcase,
  Layers,
  Sparkles,
  RefreshCw,
  Wand2,
  Download,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Coins,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepBanner } from "@/components/tool/step-banner"
import { DemoBanner } from "@/components/tool/demo-banner"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { LibraryPicker } from "@/components/tool/library-picker"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { ApiError } from "@/lib/api-client"
import { creditCosts } from "@/lib/plans"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { useLibrary } from "@/lib/use-library"
import { type LibraryItem } from "@/lib/library"
import { chapters as bidChapters } from "@/lib/sample-bid"
import { deriveHealthReport } from "@/lib/risk-derive"
import { useStep } from "@/lib/use-step"
import { useDemoMode } from "@/lib/use-demo"
import { artifactUrl, patchStep, runStep, stepResult } from "@/lib/project"
import { ChatPanel } from "./chat-panel"
import { EditorToolbar } from "./editor-toolbar"
import { ChapterNav, type Chapter } from "./chapter-nav"
import { CheckConfirm, CheckSummary, ExportConfirm } from "./check-dialogs"
import { ExportMenu, type BidType } from "./export-menu"
import { ReportDialog } from "./report-dialog"
import { useHealthCheck } from "./use-health-check"

// agent content 步结果（camelCase）：{chapterId: bodyHtml}；章结构取 outline 步结果
type RealChapters = Record<string, string>
type RealOutline = { chapters: { id: string; no: string; title: string; group: Group; sourced: boolean }[] }

type Group = "tech" | "business"

/* 标书正文取自全流程共享数据源（t5/b5 正文为空 = 待生成演示状态） */
const initialChapters: Record<Group, Chapter[]> = {
  tech: bidChapters
    .filter((c) => c.group === "tech")
    .map(({ id, no, title, sourced, body }) => ({ id, no, title, sourced, html: body })),
  business: bidChapters
    .filter((c) => c.group === "business")
    .map(({ id, no, title, sourced, body }) => ({ id, no, title, sourced, html: body })),
}

const bidTabs: { id: BidType; name: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术标", icon: FileText },
  { id: "business", name: "商务标", icon: Briefcase },
  { id: "full", name: "标书全文", icon: Layers },
]

function groupOf(id: string): Group {
  return id.startsWith("t") ? "tech" : "business"
}

/** 导出单次消耗积分（取自积分消耗表） */
const EXPORT_COST = creditCosts.find((c) => c.feature.startsWith("导出"))?.value ?? 20

export default function ContentPage() {
  // 示例内容只允许在显式 demo 模式渲染；真实项目（projectId）永远优先
  const isDemo = useDemoMode()
  const [bidType, setBidType] = useState<BidType>("tech")
  // 章节树：demo 用示例初始树；真实项目从空开始，由 outline/content 结果构建
  const [data, setData] = useState<Record<Group, Chapter[]>>(() =>
    isDemo ? initialChapters : { tech: [], business: [] },
  )

  // 真实项目：outline 树 + content 各章 HTML → 构建章节树；该步未跑则自动触发
  const { projectId, info, data: realBodies, running, error, errorStatus, start } = useStep<RealChapters>("content")
  useEffect(() => {
    if (projectId && info && !realBodies && !running && info.project.currentStep === "content") void start()
  }, [projectId, info, realBodies, running, start])
  // outline 结果一到位就先建树（正文缺失章显示"待生成"占位），content 结果到位后填充各章 HTML
  useEffect(() => {
    if (!info) return
    const ol = stepResult<RealOutline>(info, "outline")
    if (!ol) return
    const build = (g: Group) =>
      ol.chapters
        .filter((c) => c.group === g)
        .map((c) => ({ id: c.id, no: c.no, title: c.title, sourced: c.sourced, html: realBodies?.[c.id] ?? "" }))
    setData({ tech: build("tech"), business: build("business") })
    setActiveId((prev) => (ol.chapters.some((c) => c.id === prev) ? prev : (ol.chapters[0]?.id ?? "")))
  }, [realBodies, info])
  const [activeId, setActiveId] = useState<string>("t1")
  const [chatOpen, setChatOpen] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportScope, setExportScope] = useState<BidType>("full")
  const [exportFormat, setExportFormat] = useState<"word" | "pdf">("word")
  const [exportStatus, setExportStatus] = useState<string>("")
  /* 步序闸 / 402 引导提示：文案 + 引导链接（区别于 3 秒即逝的 exportStatus） */
  const [exportGate, setExportGate] = useState<{ text: string; href: string; label: string } | null>(null)
  const [hasExported, setHasExported] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const { openPaywall } = usePaywall()

  /* 真实积分余额与会员身份（GET /api/membership；仅 active 订阅算会员，决定整改建议是否完整可见） */
  const { overview, balance, isMember, loading: membershipLoading, error: membershipError, reload: reloadMembership } = useMembership()
  /* 计费口径：优先后端实时配置（运营可改），缺省回落默认值 */
  const reviewCost = creditCostValue(overview, "review", 60)
  const presentCost = creditCostValue(overview, "present", 80)
  const rewriteCost = creditCostValue(overview, "rewrite", 25)
  /* 余额是否足够支付本次导出消耗（仅影响导出付费墙，不影响整改建议解锁） */
  const canAfford = balance >= EXPORT_COST
  /* 资料库数据提升到页面级：LibraryPicker 弹层复用，避免每次打开全量重拉 */
  const { items: libItems, loading: libLoading, error: libError } = useLibrary()

  /* 真实项目且正文已生成：编辑持久化 / 单章改写通道可用 */
  const isReal = !!(projectId && realBodies)

  /* 废标体检：真实项目跑真实 review 步，demo 回落示例（content 未完成时不可体检） */
  const { checkState, findings, canCheck, runCheck, checkError, checkErrorStatus } = useHealthCheck(isReal)
  const healthCheck = useMemo(() => (findings ? deriveHealthReport(findings) : null), [findings])
  const [checkOpen, setCheckOpen] = useState(false)
  /* 体检计费确认弹层：体检（review 步）是计费步，任何路径都先显式确认；值为触发来源 */
  const [checkConfirm, setCheckConfirm] = useState<null | "check" | "export">(null)
  /* 就地完整体检报告弹层 */
  const [reportOpen, setReportOpen] = useState(false)
  const [reportExportStatus, setReportExportStatus] = useState<string>("")
  /* 从资料库插入弹层 */
  const [libraryOpen, setLibraryOpen] = useState(false)
  /* 导出前高风险二次确认 */
  const [exportConfirm, setExportConfirm] = useState(false)
  /* 用户已软放行（确认仍要导出后不再重复拦截） */
  const [softPassed, setSoftPassed] = useState(false)

  // 当前 tab 对应的章节列表（全文为技术标 + 商务标合并）
  const list: Chapter[] = bidType === "full" ? [...data.tech, ...data.business] : data[bidType]
  const active = list.find((c) => c.id === activeId) ?? list[0]
  const generatedCount = list.filter((c) => c.html.trim()).length

  // 目录分组（全文模式下展示技术标 / 商务标分组标题）
  const groups: { label: string; items: Chapter[] }[] =
    bidType === "full"
      ? [
          { label: "技术标", items: data.tech },
          { label: "商务标", items: data.business },
        ]
      : [{ label: "", items: data[bidType] }]

  function switchBid(id: BidType) {
    saveEditor()
    setBidType(id)
    const newList = id === "full" ? [...data.tech, ...data.business] : data[id]
    setActiveId(newList[0]?.id ?? "")
  }

  function selectChapter(id: string) {
    saveEditor()
    setActiveId(id)
  }

  /* 编辑持久化状态（真实项目失焦自动全量回写 content 步结果） */
  const [contentSaveState, setContentSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")

  /** 把某章正文替换进两组数据（按 id 定位，不依赖 id 前缀约定） */
  function withChapterHtml(prev: Record<Group, Chapter[]>, chapterId: string, html: string) {
    const replace = (list: Chapter[]) => list.map((c) => (c.id === chapterId ? { ...c, html } : c))
    return { tech: replace(prev.tech), business: replace(prev.business) }
  }

  /** 真实项目：把当前全部章节正文（{chapterId: html}）整份回写 content 步结果 */
  function persistContent(next: Record<Group, Chapter[]>) {
    if (!isReal || !projectId) return
    const result: Record<string, string> = {}
    for (const c of [...next.tech, ...next.business]) result[c.id] = c.html
    setContentSaveState("saving")
    patchStep(projectId, "content", result)
      .then(() => setContentSaveState("saved"))
      .catch(() => setContentSaveState("error"))
  }

  function saveEditor() {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    // 无变化不回写；上次保存失败则借下次失焦重试
    if (html === active.html && contentSaveState !== "error") return
    const next = withChapterHtml(data, active.id, html)
    setData(next)
    persistContent(next)
  }

  /** 单章改写完成：替换该章正文（后端已把改写结果合入 content 步结果，无需再回写） */
  function applyRewrite(chapterId: string, html: string) {
    setData((prev) => withChapterHtml(prev, chapterId, html))
  }

  function exec(cmd: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(cmd, false, value)
  }

  /* 从资料库插入：把条目内容拼成 HTML 插入正文光标处 */
  function insertFromLibrary(item: LibraryItem) {
    let html = ""
    if (item.body) {
      html = item.body
        .split("\n")
        .filter(Boolean)
        .map((line) => `<p>${line}</p>`)
        .join("")
    } else {
      const parts: string[] = [`<strong>${item.title}</strong>`]
      if (item.meta) parts.push(item.meta)
      if (item.fields?.length) parts.push(item.fields.map((f) => `${f.label}：${f.value}`).join("；"))
      if (item.attachments?.length) parts.push(`附件：${item.attachments.map((a) => a.name).join("、")}`)
      html = `<p>${parts.join("，")}。</p>`
    }
    exec("insertHTML", html)
    saveEditor()
    setLibraryOpen(false)
  }

  function generateChapter(id: string) {
    const g = groupOf(id)
    /* 取共享数据源中的写实正文：已写实章节回填原始 body；
       待生成章节（t5/b5，body 为空）取预置的 demoBody，绝不使用占位句 */
    const src = bidChapters.find((c) => c.id === id)
    const html = (src?.body && src.body.trim()) || src?.demoBody || ""
    if (!html) return
    setData((prev) => ({
      ...prev,
      [g]: prev[g].map((c) => (c.id === id ? { ...c, html } : c)),
    }))
    setActiveId(id)
  }

  /* 点击「一键废标体检」按钮：真实项目首次体检先显式确认计费；已有结果开合摘要弹层 */
  async function onCheckClick() {
    if (checkState === "checking" || !canCheck) return
    if (checkState === "done") {
      setCheckOpen((v) => !v)
      return
    }
    // 真实项目且 review 步从未跑过：计费步，弹确认（显示"本次体检消耗 N 积分"）
    if (isReal && !findings) {
      setCheckConfirm("check")
      return
    }
    if (await runCheck()) setCheckOpen(true)
  }

  /* 体检计费确认后真跑 review 步；从「确认导出」进入的，体检完成后继续导出流程 */
  async function confirmCheck() {
    const from = checkConfirm
    setCheckConfirm(null)
    const f = await runCheck()
    if (!f) return
    if (from === "export") {
      if (f.high > 0 && !softPassed) setExportConfirm(true)
      else doExport(exportFormat)
    } else {
      setCheckOpen(true)
    }
  }

  /* 打开就地完整体检报告（关闭其它浮层） */
  function openReport() {
    setCheckOpen(false)
    setExportConfirm(false)
    setReportOpen(true)
  }

  /* 从报告中「定位到本章修改」：切换到对应 tab 与章节并滚动到顶部 */
  function gotoChapter(tab: BidType, id: string) {
    setBidType(tab)
    setActiveId(id)
    setReportOpen(false)
    editorRef.current?.scrollTo({ top: 0 })
  }

  /* 在体检报告弹层内直接导出标书文件：已查看风险，软放行后导出 */
  function exportBidFromReport(format: "word" | "pdf") {
    setSoftPassed(true)
    setReportOpen(false)
    doExport(format)
  }

  /* 导出体检报告（Word / PDF） */
  function exportReport(format: "word" | "pdf") {
    const formatName = format === "word" ? "Word" : "PDF"
    setReportExportStatus(`正在导出体检报告（${formatName}）…`)
    setTimeout(() => {
      setReportExportStatus(`已导出体检报告（${formatName}）`)
      setTimeout(() => setReportExportStatus(""), 2500)
    }, 900)
  }

  /* 点击「导出文件」入口 */
  function onExportEntry() {
    // 余额加载中不做付费墙判定（按钮已禁用，双保险防按 balance=0 误弹）
    if (membershipLoading) return
    setExportGate(null)
    // 积分不足：弹「开通会员」付费墙；积分充足：打开导出弹窗（消耗积分）
    if (!canAfford) {
      openPaywall("export")
      return
    }
    setExportOpen((v) => !v)
  }

  function flashExportStatus(text: string) {
    setExportStatus(text)
    setTimeout(() => setExportStatus(""), 3000)
  }

  /** 步序闸：agent 图线性（…→review→present→export），export 只能在 present 完成后跑。
      currentStep 非 export/done 时不调 runStep("export")（后端必 409），改给完成路径提示。 */
  function exportGateHint(): { text: string; href: string; label: string } | null {
    const cur = info?.project.currentStep
    if (!cur || cur === "export" || cur === "done") return null
    const reviewDone = checkState === "done" || !!findings
    if (cur === "present" || reviewDone)
      return { text: `导出前需完成：述标生成（${presentCost} 积分）`, href: "/present", label: "前往述标页" }
    return {
      text: `导出前需完成：废标审查（${reviewCost} 积分）→ 述标生成（${presentCost} 积分）`,
      href: "/risk",
      label: "前往审查页",
    }
  }

  /* 付费用户在导出菜单点「确认导出」：体检未跑不再静默触发，先显式确认计费；再按风险弱拦截 */
  async function attemptExport() {
    setExportOpen(false)
    if (!canCheck) {
      flashExportStatus("完成正文生成后可体检并导出")
      return
    }
    // 体检未跑（review 步无结果）：弹计费确认，用户显式确认或跳过（跳过仅步序闸允许时可选）
    if (isReal && !findings) {
      setCheckConfirm("export")
      return
    }
    const f = checkState === "done" ? findings : await runCheck()
    if (!f) {
      flashExportStatus("体检失败，请重试")
      return
    }
    if (f.high > 0 && !softPassed) {
      setExportConfirm(true)
    } else {
      doExport(exportFormat)
    }
  }

  function doExport(_format: "word" | "pdf") {
    setExportConfirm(false)
    setExportOpen(false)
    setExportGate(null)
    // 只有真实项目才可导出（导出按钮无项目时已禁用；报告弹层等入口在此兜底提示）
    if (!projectId || !info) {
      flashExportStatus("请先从项目进入，再导出标书文件")
      return
    }
    // 步序闸：还没走到 export 步就不发请求，给出完成路径与入口链接
    const gate = exportGateHint()
    if (gate) {
      setExportGate(gate)
      return
    }
    // 真实导出：export 步（渲染完整 .docx 落 MinIO）→ 预签名 URL 直下
    setExportStatus("正在渲染完整标书…")
    void (async () => {
      try {
        if (!stepResult(info, "export")) await runStep(projectId, "export")
        window.open(await artifactUrl(projectId, "docx"), "_blank")
        setExportStatus("已导出，浏览器开始下载")
        setHasExported(true)
      } catch (e) {
        // 错误码直通：402 引导充值（持久提示），409 步骤顺序，其余通用重试
        if (e instanceof ApiError && e.status === 402) {
          setExportGate({ text: "积分不足，无法导出", href: "/membership", label: "去充值" })
          setExportStatus("")
        } else if (e instanceof ApiError && e.status === 409) {
          setExportStatus("步骤顺序不符，请先完成前序步骤")
        } else {
          setExportStatus("导出失败，请重试")
        }
      } finally {
        setTimeout(() => setExportStatus(""), 3000)
      }
    })()
  }

  /* 弹窗统一 Escape 关闭 */
  useEscapeClose(() => setExportConfirm(false), exportConfirm)
  useEscapeClose(() => setReportOpen(false), reportOpen)
  useEscapeClose(() => setCheckConfirm(null), checkConfirm !== null)

  // 非 demo 且无进行中项目：不渲染任何示例内容，引导上传 / 示例体验
  if (!projectId && !isDemo)
    return (
      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <FlowNav current="content" />
        <NoProjectGuide />
      </div>
    )

  // 真实项目：项目加载中 / 提纲缺失（章节树依赖 outline 结果）→ 占位，不回落示例
  if (!active)
    return (
      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <FlowNav current="content" />
        <StepBanner
          running={running}
          error={error}
          runningText="AI 写手团队正在按章撰写正文（多章并行，约 3–8 分钟）…"
          onRetry={() => void start()}
          action={errorStatus === 402 ? { href: "/membership", label: "去充值" } : undefined}
        />
        <StepPlaceholder
          text={!info ? "正在加载项目…" : "先完成提纲步骤，生成章节结构后再撰写正文"}
          action={info ? { href: "/outline", label: "前往提纲页" } : undefined}
        />
      </div>
    )

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
      <FlowNav current="content" />
      <StepBanner
        running={running}
        error={error}
        runningText="AI 写手团队正在按章撰写正文（多章并行，约 3–8 分钟）…"
        onRetry={() => void start()}
        action={errorStatus === 402 ? { href: "/membership", label: "去充值" } : undefined}
      />
      {isDemo && <DemoBanner />}
      {/* 头部 */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
            <FileText className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">标书生成</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              AI 逐章生成标书正文，支持在线编辑与对话润色，完成后一键导出
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* 技术标 / 商务标 / 标书全文 切换 */}
          <div className="inline-flex rounded-xl border border-border bg-card p-1">
            {bidTabs.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === bidType
              return (
                <button
                  key={tab.id}
                  onClick={() => switchBid(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? "gradient-brand text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4" />
                  {tab.name}
                </button>
              )
            })}
          </div>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="hidden items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
          >
            {chatOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            AI 助手
          </button>
        </div>
      </header>

      {/* 三栏工作区 */}
      <div
        className={`mt-4 grid min-h-0 flex-1 gap-4 ${
          chatOpen ? "lg:grid-cols-[260px_minmax(0,1fr)_340px]" : "lg:grid-cols-[260px_minmax(0,1fr)]"
        }`}
      >
        {/* 左：目录 */}
        <ChapterNav
          groups={groups}
          activeId={active.id}
          generatedCount={generatedCount}
          total={list.length}
          onSelect={selectChapter}
        />

        {/* 中：可编辑正文 */}
        <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="mr-1 text-xs font-medium text-primary">{active.no}</span>
            <span className="mr-auto truncate text-sm font-semibold text-foreground">{active.title}</span>
            {/* 编辑工具栏 */}
            <EditorToolbar exec={exec} onOpenLibrary={() => setLibraryOpen(true)} />
          </div>

          {active.html.trim() ? (
            <div
              key={active.id}
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onBlur={saveEditor}
              className="prose-sm min-h-0 flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-foreground outline-none [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-3"
              dangerouslySetInnerHTML={{ __html: active.html }}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="size-6 text-primary" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">本章节正文尚未生成</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                {active.sourced
                  ? "该章节对应招标文件要求，点击下方按钮由 AI 生成初稿后即可编辑。"
                  : "该章节为提纲新增内容，招标文件中无直接对应，建议结合自身情况补写。"}
              </p>
              {projectId ? (
                /* 真实项目不回落示例正文：引导走真实改写通道（content 生成中由顶部横幅提示进度） */
                <p className="mt-5 max-w-xs rounded-xl border border-primary/20 gradient-brand-soft px-4 py-2.5 text-xs leading-relaxed text-primary">
                  在右侧 AI 助手中选中本章并输入指令，由 AI 生成/改写本章正文（{rewriteCost} 积分/次）
                </p>
              ) : (
                <button
                  onClick={() => generateChapter(active.id)}
                  className="mt-5 inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  <Wand2 className="size-4" />
                  AI 生成本章正文
                </button>
              )}
            </div>
          )}

          {active.html.trim() && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
              {projectId ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <RefreshCw className="size-3.5" />
                  重写本章可在右侧 AI 助手输入指令（{rewriteCost} 积分/次）
                </span>
              ) : (
                <button
                  onClick={() => generateChapter(active.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <RefreshCw className="size-3.5" />
                  重新生成
                </button>
              )}
              <span
                className={`ml-auto text-xs ${contentSaveState === "error" ? "font-medium text-destructive" : "text-muted-foreground"}`}
              >
                {!isReal
                  ? "编辑后自动保存"
                  : contentSaveState === "saving"
                    ? "保存中…"
                    : contentSaveState === "error"
                      ? "保存失败，编辑后将自动重试"
                      : contentSaveState === "saved"
                        ? "已保存"
                        : "编辑后自动保存"}
              </span>
            </div>
          )}
        </section>

        {/* 右：AI 对话（真实项目走单章改写通道） */}
        {chatOpen && (
          <ChatPanel
            chapters={[...data.tech, ...data.business].map((c) => ({ id: c.id, no: c.no, title: c.title }))}
            activeId={active.id}
            projectId={projectId}
            contentReady={isReal}
            balance={balance}
            rewriteCost={rewriteCost}
            onApply={applyRewrite}
            refreshBalance={reloadMembership}
            onOpenLibrary={() => setLibraryOpen(true)}
          />
        )}
      </div>

      {/* 底部：废标体检 + 导出文件 */}
      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        {/* 当前积分余额（真实值；导出等操作按积分消耗）；加载中显示占位，失败给可见提示 */}
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          <Coins className="size-3" />
          余额：{membershipLoading ? "…" : `${balance} 积分`}
          {membershipError && <span className="text-destructive">{membershipError}</span>}
        </span>

        <div className="flex flex-wrap items-center gap-3">
          {hasExported && (
            <span className="hidden text-xs text-muted-foreground lg:inline">导出后可在「我的标书」随时重新下载</span>
          )}
          {exportStatus && <span className="text-xs font-medium text-primary">{exportStatus}</span>}
          {/* 步序闸 / 积分不足提示：说明还差哪些步骤（含费用），附入口链接 */}
          {exportGate && (
            <span className="text-xs font-medium text-destructive">
              {exportGate.text}
              <Link href={exportGate.href} className="ml-1.5 font-semibold text-primary underline">
                {exportGate.label}
              </Link>
            </span>
          )}

          {hasExported && (
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileText className="size-4" />
              我的标书
            </Link>
          )}

          {/* 一键废标体检（真实项目跑 review 步；content 未完成时禁用） */}
          <div className="relative">
            <button
              onClick={() => void onCheckClick()}
              disabled={checkState === "checking" || !canCheck}
              title={!canCheck ? "完成正文生成后可体检" : undefined}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                checkState === "done" && (healthCheck?.high ?? 0) > 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                  : checkState === "done"
                    ? "border-success/40 bg-success/10 text-success hover:bg-success/15"
                    : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {checkState === "checking" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  体检中…（跑真实审查，约 1–2 分钟）
                </>
              ) : checkState === "done" && healthCheck ? (
                healthCheck.high > 0 ? (
                  <>
                    <ShieldAlert className="size-4" />
                    {healthCheck.high} 项高风险
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-4" />
                    体检通过
                  </>
                )
              ) : (
                <>
                  <ShieldCheck className="size-4" />
                  {/* 计费告知：真实项目首次体检显示消耗（已有结果时开合免费） */}
                  一键废标体检{isReal && !findings ? `（${reviewCost} 积分）` : ""}
                </>
              )}
            </button>
            {checkState !== "checking" && checkError && (
              <span className="absolute -top-5 right-0 whitespace-nowrap text-[11px] font-medium text-destructive">
                {checkError}
                {checkErrorStatus === 402 && (
                  <Link href="/membership" className="ml-1 font-semibold text-primary underline">
                    去充值
                  </Link>
                )}
              </span>
            )}

            {/* 体检结果摘要弹层 */}
            {checkOpen && checkState === "done" && healthCheck && (
              <CheckSummary
                report={healthCheck}
                isMember={isMember}
                onClose={() => setCheckOpen(false)}
                onOpenReport={openReport}
              />
            )}
          </div>

          {/* 导出文件 */}
          <div className="relative">
            <button
              onClick={onExportEntry}
              disabled={membershipLoading || !projectId}
              title={!projectId ? "请先从项目进入" : undefined}
              className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="size-4" />
              {membershipLoading ? "余额加载中…" : "导出文件"}
            </button>

            {/* 导出菜单（积分不足时已走付费墙，不会展开） */}
            {exportOpen && canAfford && (
              <ExportMenu
                scope={exportScope}
                format={exportFormat}
                cost={EXPORT_COST}
                balance={balance}
                onScope={setExportScope}
                onFormat={setExportFormat}
                onConfirm={() => void attemptExport()}
                onClose={() => setExportOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* 体检计费确认（体检按钮 / 确认导出两个入口共用；跳过导出仅步序闸允许时提供） */}
      {checkConfirm && (
        <CheckConfirm
          cost={reviewCost}
          balance={balance}
          note={checkConfirm === "export" ? `体检完成后还需完成述标生成（${presentCost} 积分），才能导出标书文件。` : undefined}
          skip={
            checkConfirm === "export" && !exportGateHint()
              ? {
                  label: "跳过体检直接导出",
                  onSkip: () => {
                    setCheckConfirm(null)
                    doExport(exportFormat)
                  },
                }
              : undefined
          }
          onConfirm={() => void confirmCheck()}
          onClose={() => setCheckConfirm(null)}
        />
      )}

      {/* 导出前高风险二次确认 */}
      {exportConfirm && healthCheck && (
        <ExportConfirm
          report={healthCheck}
          onViewReport={openReport}
          onExportAnyway={() => {
            setSoftPassed(true)
            setExportConfirm(false)
            doExport(exportFormat)
          }}
          onClose={() => setExportConfirm(false)}
        />
      )}

      {/* 就地完整体检报告（针对当前这份标书草稿） */}
      {reportOpen && healthCheck && (
        <ReportDialog
          report={healthCheck}
          exportStatus={reportExportStatus}
          onClose={() => setReportOpen(false)}
          onGoto={gotoChapter}
          onExportReport={exportReport}
          onExportBid={exportBidFromReport}
        />
      )}

      {/* 从资料库插入选择器（数据由页面级 useLibrary 提供） */}
      {libraryOpen && (
        <LibraryPicker
          items={libItems}
          loading={libLoading}
          error={libError}
          onClose={() => setLibraryOpen(false)}
          onPick={insertFromLibrary}
        />
      )}
    </div>
  )
}
