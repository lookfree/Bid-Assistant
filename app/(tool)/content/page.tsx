"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import {
  FileText,
  Briefcase,
  Layers,
  Sparkles,
  Bold,
  Italic,
  List,
  ImagePlus,
  Heading2,
  RefreshCw,
  Wand2,
  Send,
  Bot,
  User,
  CheckCircle2,
  AlertTriangle,
  Download,
  FileType2,
  FileText as FileDoc,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Lock,
  ArrowRight,
  Library,
  Search,
  Paperclip,
  X,
  Coins,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { CreditEstimate } from "@/components/credit-estimate"
import { FlowNav } from "@/components/tool/flow-nav"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { creditCosts, DEMO_CREDIT_BALANCE } from "@/lib/plans"
import { libraryCategories, type LibraryItem, type LibraryCategoryId } from "@/lib/library"
import { chapters as bidChapters, riskFindings } from "@/lib/sample-bid"

type BidType = "tech" | "business" | "full"
type Group = "tech" | "business"

type Chapter = {
  id: string
  no: string
  title: string
  /** 是否能在招标文件中索引到来源；false 表示提纲新增、正文缺失需补写 */
  sourced: boolean
  /** 已生成的正文 HTML；空字符串表示尚未生成（缺失） */
  html: string
}

type ChatMsg = { role: "user" | "ai"; text: string }

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

const exportScopes: { id: BidType; name: string; desc: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术文件", desc: "仅导出技术标全部章节", icon: FileText },
  { id: "business", name: "商务文件", desc: "仅导出商务标全部章节", icon: Briefcase },
  { id: "full", name: "标书全文", desc: "技术标 + 商务标合并导出", icon: Layers },
]

function groupOf(id: string): Group {
  return id.startsWith("t") ? "tech" : "business"
}

type CheckItem = {
  level: string
  tone: "destructive" | "warning"
  title: string
  chapter: string
  advice: string
  /** 定位目标：标书 tab 与章节 id */
  targetTab: BidType
  targetId: string
}

/* 废标体检结果取自全流程共享风险项，确保与审查页一致 */
const healthCheck = {
  score: riskFindings.score,
  high: riskFindings.high,
  mid: riskFindings.mid,
  passed: riskFindings.passed,
  items: riskFindings.items.map((f) => ({
    level: f.level,
    tone: f.tone,
    title: f.title,
    chapter: f.chapterTitle,
    advice: f.advice,
    targetTab: f.targetTab,
    targetId: f.targetId,
  })) as CheckItem[],
  /* 已通过项（供完整报告展示） */
  passedItems: riskFindings.passedItems,
}

const checkToneClasses: Record<CheckItem["tone"], { badge: string; border: string }> = {
  destructive: { badge: "bg-destructive/10 text-destructive", border: "border-destructive/30" },
  warning: { badge: "bg-warning/15 text-warning-foreground", border: "border-warning/30" },
}

/** 导出单次消耗积分（取自积分消耗表） */
const EXPORT_COST = creditCosts.find((c) => c.feature.startsWith("导出"))?.value ?? 20

export default function ContentPage() {
  const [bidType, setBidType] = useState<BidType>("tech")
  const [data, setData] = useState(initialChapters)
  const [activeId, setActiveId] = useState<string>("t1")
  const [chatOpen, setChatOpen] = useState(true)
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: "ai", text: "你好，我是智启元 · 投标助手。选中左侧章节后，可以让我帮你改写、扩写或调整这一处的内容。" },
  ])
  const [input, setInput] = useState("")
  const [exportOpen, setExportOpen] = useState(false)
  const [exportScope, setExportScope] = useState<BidType>("full")
  const [exportFormat, setExportFormat] = useState<"word" | "pdf">("word")
  const [exportStatus, setExportStatus] = useState<string>("")
  const [hasExported, setHasExported] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const { openPaywall } = usePaywall()

  /* 演示积分余额：用于切换「余额充足走导出弹窗 / 余额不足弹开通会员」两种体验 */
  const [balance, setBalance] = useState(DEMO_CREDIT_BALANCE)
  /* 余额是否足够支付本次导出消耗（仅影响导出付费墙，不影响整改建议解锁） */
  const canAfford = balance >= EXPORT_COST
  /* 演示用：是否为付费会员，决定整改建议是否完整可见 */
  const [isMember, setIsMember] = useState(false)

  /* 废标体检状态 */
  const [checkState, setCheckState] = useState<"idle" | "checking" | "done">("idle")
  const [checkOpen, setCheckOpen] = useState(false)
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
    setActiveId(newList[0].id)
  }

  function selectChapter(id: string) {
    saveEditor()
    setActiveId(id)
  }

  function saveEditor() {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    const g = groupOf(active.id)
    setData((prev) => ({
      ...prev,
      [g]: prev[g].map((c) => (c.id === active.id ? { ...c, html } : c)),
    }))
  }

  function exec(cmd: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(cmd, false, value)
  }

  function insertImage() {
    const url = "/professional-business-chart.png"
    exec("insertHTML", `<img src="${url}" alt="示意图" class="my-3 rounded-lg border border-border max-w-full" />`)
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
      if (item.attachments?.length) parts.push(`附件：${item.attachments.join("、")}`)
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

  function sendMessage() {
    const text = input.trim()
    if (!text) return
    setChat((prev) => [...prev, { role: "user", text }])
    setInput("")
    setTimeout(() => {
      setChat((prev) => [
        ...prev,
        {
          role: "ai",
          text: `已针对「${active.no} ${active.title}」理解你的要求："${text}"。建议在本章节中补充对应论述，你可以点击下方按钮将修改应用到正文。`,
        },
      ])
    }, 500)
  }

  /* 运行废标体检；done 后执行可选回调 */
  function runCheck(after?: () => void) {
    setCheckState("checking")
    setTimeout(() => {
      setCheckState("done")
      after?.()
    }, 1200)
  }

  /* 点击「一键废标体检」按钮 */
  function onCheckClick() {
    if (checkState === "checking") return
    if (checkState === "idle") {
      runCheck(() => setCheckOpen(true))
    } else {
      setCheckOpen((v) => !v)
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
    // 积分不足：弹「开通会员」付费墙；积分充足：打开导出弹窗（消耗积分）
    if (!canAfford) {
      openPaywall("export")
      return
    }
    setExportOpen((v) => !v)
  }

  /* 付费用户在导出菜单点「确认导出」：先体检，再按风险弱拦截 */
  function attemptExport() {
    setExportOpen(false)
    if (checkState !== "done") {
      runCheck(evaluateAndExport)
    } else {
      evaluateAndExport()
    }
  }

  function evaluateAndExport() {
    if (healthCheck.high > 0 && !softPassed) {
      setExportConfirm(true)
    } else {
      doExport(exportFormat)
    }
  }

  function doExport(format: "word" | "pdf") {
    const scopeName = exportScopes.find((s) => s.id === exportScope)?.name ?? "标书全文"
    const formatName = format === "word" ? "Word" : "PDF"
    setExportConfirm(false)
    setExportOpen(false)
    setExportStatus(`正在导出 ${scopeName}（${formatName}）…`)
    setTimeout(() => {
      setExportStatus(`已导出 ${scopeName}（${formatName}）`)
      setHasExported(true)
      setTimeout(() => setExportStatus(""), 2500)
    }, 900)
  }

  /* 弹窗统一 Escape 关闭 */
  useEscapeClose(() => setExportConfirm(false), exportConfirm)
  useEscapeClose(() => setReportOpen(false), reportOpen)

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
      <FlowNav current="content" />
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
        <aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-foreground">标书目录</span>
            <span className="text-xs text-muted-foreground">
              {generatedCount}/{list.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {groups.map((grp) => (
              <div key={grp.label || "single"} className="mb-1">
                {grp.label && (
                  <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {grp.label}
                  </div>
                )}
                {grp.items.map((ch) => {
                  const isActive = ch.id === active.id
                  const isMissing = !ch.html.trim()
                  return (
                    <button
                      key={ch.id}
                      onClick={() => selectChapter(ch.id)}
                      className={`mb-1 flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        isActive ? "gradient-brand-soft border border-primary/30" : "hover:bg-muted"
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {isMissing ? (
                          <AlertTriangle className="size-4 text-warning-foreground" />
                        ) : (
                          <CheckCircle2 className="size-4 text-success" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-medium text-primary">{ch.no}</span>
                        <span className="block truncate text-[13px] font-medium text-foreground">{ch.title}</span>
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {!ch.sourced && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              新增
                            </span>
                          )}
                          {isMissing && (
                            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning-foreground">
                              待生成
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* 中：可编辑正文 */}
        <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="mr-1 text-xs font-medium text-primary">{active.no}</span>
            <span className="mr-auto truncate text-sm font-semibold text-foreground">{active.title}</span>
            {/* 编辑工具栏 */}
            <div className="flex items-center gap-0.5">
              <ToolBtn onClick={() => exec("bold")} label="加粗">
                <Bold className="size-4" />
              </ToolBtn>
              <ToolBtn onClick={() => exec("italic")} label="斜体">
                <Italic className="size-4" />
              </ToolBtn>
              <ToolBtn onClick={() => exec("formatBlock", "<h3>")} label="小标题">
                <Heading2 className="size-4" />
              </ToolBtn>
              <ToolBtn onClick={() => exec("insertUnorderedList")} label="列表">
                <List className="size-4" />
              </ToolBtn>
              <ToolBtn onClick={insertImage} label="插入图片">
                <ImagePlus className="size-4" />
              </ToolBtn>
              <button
                onClick={() => setLibraryOpen(true)}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-primary/30 gradient-brand-soft px-2.5 py-1.5 text-xs font-medium text-primary transition-opacity hover:opacity-90"
              >
                <Library className="size-3.5" />
                从资料库插入
              </button>
            </div>
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
              <button
                onClick={() => generateChapter(active.id)}
                className="mt-5 inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Wand2 className="size-4" />
                AI 生成本章正文
              </button>
            </div>
          )}

          {active.html.trim() && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
              <button
                onClick={() => generateChapter(active.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <RefreshCw className="size-3.5" />
                重新生成
              </button>
              <span className="ml-auto text-xs text-muted-foreground">编辑后自动保存</span>
            </div>
          )}
        </section>

        {/* 右：AI 对话 */}
        {chatOpen && (
          <aside className="hidden min-h-0 flex-col rounded-2xl border border-border bg-card lg:flex">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className="flex size-7 items-center justify-center rounded-lg gradient-brand">
                <Bot className="size-4 text-white" />
              </span>
              <span className="text-sm font-semibold text-foreground">智启元 · 投标助手</span>
              <span className="ml-auto truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {active.no}
              </span>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {chat.map((m, i) => (
                <div key={i} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                      m.role === "user" ? "bg-secondary" : "gradient-brand"
                    }`}
                  >
                    {m.role === "user" ? (
                      <User className="size-3.5 text-foreground" />
                    ) : (
                      <Bot className="size-3.5 text-white" />
                    )}
                  </span>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>

            {/* 快捷指令 */}
            <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
              <button
                onClick={() => setLibraryOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 gradient-brand-soft px-2.5 py-1 text-[11px] font-medium text-primary transition-opacity hover:opacity-90"
              >
                <Library className="size-3" />
                从资料库插入
              </button>
              {["扩写本章", "更正式", "提炼要点", "补充案例"].map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {q}
                </button>
              ))}
            </div>

            <div className="border-t border-border p-3">
              <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:border-primary">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      sendMessage()
                    }
                  }}
                  rows={1}
                  placeholder={`针对「${active.title}」提出修改…`}
                  className="max-h-24 min-h-0 flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg gradient-brand text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Send className="size-4" />
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* 底部：废标体检 + 导出文件 */}
      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        {/* 演示切换：积分余额（影响导出付费墙）+ 会员身份（影响整改建议解锁） */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setBalance((v) => (v >= EXPORT_COST ? Math.max(0, EXPORT_COST - 10) : DEMO_CREDIT_BALANCE))}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="演示用：切换积分余额充足 / 不足"
          >
            <Coins className="size-3" />
            余额：{balance} 积分（{canAfford ? "充足" : "不足"}）
          </button>
          <button
            onClick={() => setIsMember((v) => !v)}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="演示用：切换免费用户 / 付费会员"
          >
            <User className="size-3" />
            身份：{isMember ? "付费会员" : "免费用户"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {hasExported && (
            <span className="hidden text-xs text-muted-foreground lg:inline">导出��可在「我的标书」随时重新下载</span>
          )}
          {exportStatus && <span className="text-xs font-medium text-primary">{exportStatus}</span>}

          {hasExported && (
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileText className="size-4" />
              我的标书
            </Link>
          )}

          {/* 一键废标体检 */}
          <div className="relative">
            <button
              onClick={onCheckClick}
              disabled={checkState === "checking"}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
                checkState === "done" && healthCheck.high > 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                  : checkState === "done"
                    ? "border-success/40 bg-success/10 text-success hover:bg-success/15"
                    : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {checkState === "checking" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  体检中…
                </>
              ) : checkState === "done" ? (
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
                  一键废标体检
                </>
              )}
            </button>

            {/* 体检结果摘要弹层 */}
            {checkOpen && checkState === "done" && (
              <>
                <button
                  aria-label="关闭体检摘要"
                  onClick={() => setCheckOpen(false)}
                  className="fixed inset-0 z-40 cursor-default"
                />
                <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-2xl border border-border bg-card p-4 shadow-lg">
                  {/* 健康分 + 计数 */}
                  <div className="flex items-center gap-3 border-b border-border pb-3">
                    <div className="flex size-12 shrink-0 flex-col items-center justify-center rounded-xl gradient-brand-soft">
                      <span className="text-lg font-bold leading-none text-primary">{healthCheck.score}</span>
                      <span className="text-[9px] text-muted-foreground">健康分</span>
                    </div>
                    <div className="flex flex-1 items-center justify-between text-center text-xs">
                      <span className="flex flex-col">
                        <span className="text-sm font-bold text-destructive">{healthCheck.high}</span>
                        <span className="text-muted-foreground">高风险</span>
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm font-bold text-warning-foreground">{healthCheck.mid}</span>
                        <span className="text-muted-foreground">中风险</span>
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm font-bold text-success">{healthCheck.passed}</span>
                        <span className="text-muted-foreground">已通过</span>
                      </span>
                    </div>
                  </div>

                  {/* 逐条风险 */}
                  <div className="mt-3 flex max-h-56 flex-col gap-2 overflow-y-auto">
                    {healthCheck.items.map((it, i) => {
                      const tc = checkToneClasses[it.tone]
                      return (
                        <div key={i} className={`rounded-xl border ${tc.border} p-2.5`}>
                          <div className="flex items-center gap-1.5">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tc.badge}`}>{it.level}</span>
                            <span className="truncate text-[12px] font-medium text-foreground">{it.title}</span>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">{it.chapter}</p>
                          {/* 整改建议：非会员模糊处理 */}
                          {isMember ? (
                            <p className="mt-1 text-[11px] leading-relaxed text-foreground">{it.advice}</p>
                          ) : (
                            <div className="relative mt-1">
                              <p className="select-none text-[11px] leading-relaxed text-foreground blur-[3px]">
                                {it.advice}
                              </p>
                              <div className="absolute inset-0 flex items-center justify-center">
                                <Link
                                  href="/membership"
                                  className="inline-flex items-center gap-1 rounded-full bg-card/80 px-2 py-0.5 text-[10px] font-medium text-primary transition-opacity hover:opacity-80"
                                >
                                  <Lock className="size-3" />
                                  解锁查看完整整改建议
                                </Link>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <button
                    onClick={openReport}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    查看完整体检报告
                    <ArrowRight className="size-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 导出文件 */}
          <div className="relative">
            <button
              onClick={onExportEntry}
              className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Download className="size-4" />
              导出文件
            </button>

            {/* 导出菜单（积分不足时已走付费墙，不会展开） */}
            {exportOpen && canAfford && (
              <>
                <button
                  aria-label="关闭导出菜单"
                  onClick={() => setExportOpen(false)}
                  className="fixed inset-0 z-40 cursor-default"
                />
                <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-2xl border border-border bg-card p-3 shadow-lg">
                  <p className="px-1 pb-2 text-xs font-semibold text-foreground">选择导出范围</p>
                  <div className="flex flex-col gap-1">
                    {exportScopes.map((s) => {
                      const Icon = s.icon
                      const isActive = exportScope === s.id
                      return (
                        <button
                          key={s.id}
                          onClick={() => setExportScope(s.id)}
                          className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                            isActive ? "border-primary/40 gradient-brand-soft" : "border-border hover:bg-muted"
                          }`}
                        >
                          <Icon className={`mt-0.5 size-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium text-foreground">{s.name}</span>
                            <span className="block text-[11px] text-muted-foreground">{s.desc}</span>
                          </span>
                          {isActive && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />}
                        </button>
                      )
                    })}
                  </div>

                  <p className="px-1 pb-2 pt-3 text-xs font-semibold text-foreground">选择导出格式</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setExportFormat("word")}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                        exportFormat === "word" ? "border-primary/40 gradient-brand-soft text-foreground" : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      <FileDoc className="size-4 text-primary" />
                      Word
                    </button>
                    <button
                      onClick={() => setExportFormat("pdf")}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                        exportFormat === "pdf" ? "border-primary/40 gradient-brand-soft text-foreground" : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      <FileType2 className="size-4 text-destructive" />
                      PDF
                    </button>
                  </div>

                  {/* 积分预估 */}
                  <div className="mt-3">
                    <CreditEstimate
                      cost={EXPORT_COST}
                      balance={balance}
                      showSupportable={false}
                      actionLabel="确认导出"
                      onConfirm={attemptExport}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 导出前高风险二次确认 */}
      {exportConfirm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={() => setExportConfirm(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导出前发现废标高风险"
            className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl"
          >
            <button
              onClick={() => setExportConfirm(false)}
              aria-label="关闭"
              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
            <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <ShieldAlert className="size-5" />
            </div>
            <h2 className="mt-4 text-lg font-bold text-foreground">导出前发现废标高风险</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              本次体检发现 {healthCheck.high} 项高风险（如「缺少 ISO27001 信息安全管理体系认证」），可能导致直接废标。建议先处理风险再导出。
            </p>
            <div className="mt-5 flex flex-col gap-2.5">
              <button
                onClick={openReport}
                className="inline-flex items-center justify-center gap-2 rounded-xl gradient-brand px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <ShieldCheck className="size-4" />
                查看并处理风险
              </button>
              <button
                onClick={() => {
                  setSoftPassed(true)
                  setExportConfirm(false)
                  doExport(exportFormat)
                }}
                className="inline-flex items-center justify-center rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                仍要导出
              </button>
              <button
                onClick={() => setExportConfirm(false)}
                className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                取消（留在编辑）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 就地完整体检报告（针对当前这份标书草稿） */}
      {reportOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={() => setReportOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          >
            {/* 头部：健康分 + 计数 */}
            <div className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div className="flex items-center gap-4">
                <div className="flex size-16 shrink-0 flex-col items-center justify-center rounded-2xl gradient-brand-soft">
                  <span className="text-2xl font-bold leading-none text-primary">{healthCheck.score}</span>
                  <span className="mt-0.5 text-[10px] text-muted-foreground">健康分</span>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-foreground">废标体检报告</h2>
                  <p className="mt-1 text-xs text-muted-foreground">针对当前这份标书草稿的投递前自检</p>
                  <div className="mt-2 flex items-center gap-4 text-xs">
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <ShieldAlert className="size-3.5" />
                      高风险 {healthCheck.high}
                    </span>
                    <span className="inline-flex items-center gap-1 text-warning-foreground">
                      <AlertTriangle className="size-3.5" />
                      中风险 {healthCheck.mid}
                    </span>
                    <span className="inline-flex items-center gap-1 text-success">
                      <CheckCircle2 className="size-3.5" />
                      已通过 {healthCheck.passed}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setReportOpen(false)}
                aria-label="关闭报告"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* 正文：逐条风险 + 已通过项 */}
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-xs font-semibold text-foreground">待处理风险项</p>
              <div className="mt-2 flex flex-col gap-3">
                {healthCheck.items.map((it, i) => {
                  const tc = checkToneClasses[it.tone]
                  return (
                    <div key={i} className={`rounded-xl border ${tc.border} p-3.5`}>
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tc.badge}`}>{it.level}</span>
                        <span className="text-sm font-medium text-foreground">{it.title}</span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-foreground">{it.advice}</p>
                      <div className="mt-3 flex items-center justify-between">
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <FileText className="size-3.5" />
                          {it.chapter}
                        </span>
                        <button
                          onClick={() => gotoChapter(it.targetTab, it.targetId)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 gradient-brand-soft px-3 py-1.5 text-xs font-semibold text-primary transition-opacity hover:opacity-90"
                        >
                          定位到本章修改
                          <ArrowRight className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="mt-5 text-xs font-semibold text-foreground">已通过项</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {healthCheck.passedItems.map((p, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg bg-success/5 px-3 py-2">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                    <span className="text-xs text-foreground">{p}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 底部：导出体检报告 + 导出标书文件 + 免责说明，区别于独立的 /risk */}
            <div className="border-t border-border bg-muted/40 px-5 py-3.5">
              {reportExportStatus && (
                <p className="mb-2.5 text-[11px] font-medium text-primary">{reportExportStatus}</p>
              )}
              <div className="flex flex-col gap-3">
                {/* 导出体检报告 */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs font-medium text-foreground">导出体检报告</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => exportReport("word")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <FileDoc className="size-3.5 text-primary" />
                      导出 Word
                    </button>
                    <button
                      onClick={() => exportReport("pdf")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <FileType2 className="size-3.5 text-destructive" />
                      导出 PDF
                    </button>
                  </div>
                </div>

                {/* 导出标书文件（已查看风险后软放行导出） */}
                <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs font-medium text-foreground">导出标书文件</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => exportBidFromReport("word")}
                      className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <FileDoc className="size-3.5" />
                      导出 Word
                    </button>
                    <button
                      onClick={() => exportBidFromReport("pdf")}
                      className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <FileType2 className="size-3.5" />
                      导出 PDF
                    </button>
                  </div>
                </div>

                <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
                  体检仅供投递前自检，不替代正式标书审查。如需对任意标书做完整合规比对，请使用
                  <Link href="/risk" className="mx-0.5 font-medium text-primary hover:underline">
                    标书审查
                  </Link>
                  工具。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 从资料库插入选择器 */}
      {libraryOpen && <LibraryPicker onClose={() => setLibraryOpen(false)} onPick={insertFromLibrary} />}
    </div>
  )
}

/* 资料库内容选择器：分类切换 + 搜索 + 点击插入 */
function LibraryPicker({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (item: LibraryItem) => void
}) {
  const [cat, setCat] = useState<LibraryCategoryId>("text")
  const [q, setQ] = useState("")
  useEscapeClose(onClose)
  const current = libraryCategories.find((c) => c.id === cat)!
  const items = q.trim()
    ? current.items.filter(
        (it) =>
          it.title.includes(q.trim()) ||
          it.meta?.includes(q.trim()) ||
          it.tags?.some((t) => t.includes(q.trim())),
      )
    : current.items

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Library className="size-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">从资料库插入</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

        {/* 分类 + 搜索 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          {libraryCategories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                cat === c.id ? "gradient-brand text-white" : "border border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.title}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索"
              className="w-28 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>

        {/* 条目列表 */}
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">未找到匹配条目</p>}
          <div className="flex flex-col gap-2">
            {items.map((it) => (
              <button
                key={it.id}
                onClick={() => onPick(it)}
                className="group flex items-start justify-between gap-3 rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{it.title}</p>
                  {it.meta && <p className="mt-0.5 text-xs text-muted-foreground">{it.meta}</p>}
                  {it.body && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{it.body}</p>}
                  {it.attachments?.length ? (
                    <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Paperclip className="size-3" />
                      {it.attachments.join("、")}
                    </span>
                  ) : null}
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  插入
                  <ArrowRight className="size-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolBtn({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}
