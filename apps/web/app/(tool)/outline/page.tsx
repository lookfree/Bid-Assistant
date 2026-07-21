"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  FileText,
  Briefcase,
  Layers,
  ListTree,
  MapPin,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Pencil,
  Trash2,
  Plus,
  Check,
  X,
  Loader2,
  Save,
} from "lucide-react"
import type { OutlineItem, BidChapter } from "@/lib/bid-types"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { StepBanner } from "@/components/tool/step-banner"
import { TenderDocPanel } from "@/components/tool/tender-doc-panel"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"
import { AiNotice } from "@/components/tool/ai-notice"
import { useStep, useOtherStepResult } from "@/lib/use-step"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { patchErrorMessage, patchStep } from "@/lib/project"
import { clauseLocationIn, groupDocSections, type DocSentence } from "@/lib/doc-sections"

// agent Outline（camelCase）：chapters[{id,no,title,group,sourced,items[{id,label,clauseIds,isNew}]}]
type RealOutline = { chapters: (BidChapter & { group: "tech" | "business" })[] }

/* ---------------- 提纲数据（取自全流程共享数据源） ---------------- */
type Chapter = {
  id: string
  no: string
  title: string
  /** 是否能在招标文件中索引到来源（保存回写 Outline 契约需要） */
  sourced: boolean
  items: OutlineItem[]
}

const toOutline = (list: BidChapter[]): Chapter[] =>
  list.map(({ id, no, title, sourced, items }) => ({
    id,
    no,
    title,
    sourced,
    items: items.map((it) => ({ ...it })),
  }))

type TabId = "tech" | "business" | "full"

const tabs: { id: TabId; name: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术标大纲", icon: FileText },
  { id: "business", name: "商务标大纲", icon: Briefcase },
  { id: "full", name: "全文大纲", icon: Layers },
]

let idCounter = 0
const genId = () => `gen-${Date.now()}-${idCounter++}`

export default function OutlinePage() {
  // 计费步绝不自动触发：该步未跑时停在显式生成入口，用户点击才跑
  const { projectId, info, data: real, dataLoading, running, phase, error, errorAction, start } = useStep<RealOutline>("outline")
  const { overview } = useMembership()
  const outlineCost = creditCostValue(overview, "outline", 30)

  // 左栏原文：取 read 步结果的分句（按 id 前缀分组），未就绪为空（占位）
  // read 结果按需拉取（slim 首屏不携带跨步结果）：原文栏 doc_sections 来自这里
  const { data: readResult } = useOtherStepResult<{
    docSections?: DocSentence[]
    /** 多文件读标（spec320）各文件章节区间：原文栏文件页签用 */
    docFiles?: { name: string; secFrom: number; secTo: number }[]
  }>(projectId, info, "read")
  const docSections = useMemo(
    () => (readResult?.docSections?.length ? groupDocSections(readResult.docSections) : []),
    [readResult],
  )
  const locate = (clauseIds?: string[]) => clauseLocationIn(docSections, clauseIds)
  // 头部文件名：项目名（缺省兜底）
  const docFileName = info?.project.name ?? "我的项目"

  const clauseRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  const [activeClauses, setActiveClauses] = useState<string[]>([])
  const [activeSection, setActiveSection] = useState<string>(docSections[0]?.id ?? "")
  const [activeItem, setActiveItem] = useState<string>("")
  const [activeTab, setActiveTab] = useState<TabId>("tech")

  // 提纲树：从空开始，outline 结果到位后覆盖
  const [techChapters, setTechChapters] = useState<Chapter[]>([])
  const [businessChapters, setBusinessChapters] = useState<Chapter[]>([])
  useEffect(() => {
    if (!real) return
    setTechChapters(toOutline(real.chapters.filter((c) => c.group === "tech")))
    setBusinessChapters(toOutline(real.chapters.filter((c) => c.group === "business")))
  }, [real])

  // 提纲编辑保存：把当前树序列化回 Outline 形状整份回写（仅该步有真实 done 结果时按钮才出现）
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveError, setSaveError] = useState<string>("")
  async function saveOutline() {
    if (!projectId || saveState === "saving") return
    setSaveState("saving")
    const serialize = (list: Chapter[], group: "tech" | "business") =>
      list.map((ch) => ({
        id: ch.id,
        no: ch.no,
        title: ch.title,
        group,
        sourced: ch.sourced,
        items: ch.items.map((it) => ({
          id: it.id,
          label: it.label,
          clauseIds: it.clauseIds ?? [],
          isNew: it.isNew ?? false,
        })),
      }))
    try {
      await patchStep(projectId, "outline", {
        chapters: [...serialize(techChapters, "tech"), ...serialize(businessChapters, "business")],
      })
      setSaveState("saved")
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500)
    } catch (e) {
      // 404 = 该步无真实 done 结果（step_not_done），精确提示而非笼统"保存失败"
      setSaveError(patchErrorMessage(e))
      setSaveState("error")
    }
  }

  // 正在编辑的目标：条目或章节标题
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [editingChapter, setEditingChapter] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // 当前标签对应的分组
  const groups: { label: string; kind: "tech" | "business"; chapters: Chapter[] }[] =
    activeTab === "tech"
      ? [{ label: "技术标", kind: "tech", chapters: techChapters }]
      : activeTab === "business"
        ? [{ label: "商务标", kind: "business", chapters: businessChapters }]
        : [
            { label: "技术标", kind: "tech", chapters: techChapters },
            { label: "商务标", kind: "business", chapters: businessChapters },
          ]

  const allItems = groups.flatMap((g) => g.chapters).flatMap((c) => c.items)
  const indexedCount = allItems.filter((i) => i.clauseIds && i.clauseIds.length > 0).length
  const newCount = allItems.filter((i) => i.isNew).length

  function setter(kind: "tech" | "business") {
    return kind === "tech" ? setTechChapters : setBusinessChapters
  }

  function handleItemClick(clauseIds: string[] | undefined, key: string) {
    if (!clauseIds || clauseIds.length === 0) return
    setActiveClauses(clauseIds)
    setActiveItem(key)
    setActiveSection(clauseIds[0].replace(/-c\d+$/, ""))
    clauseRefs.current[clauseIds[0]]?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  /* -------- 条目编辑 -------- */
  function startEditItem(item: OutlineItem) {
    setEditingChapter(null)
    setEditingItem(item.id)
    setDraft(item.label)
  }

  function saveItem(kind: "tech" | "business", chapterId: string, itemId: string) {
    const text = draft.trim()
    if (!text) {
      setEditingItem(null)
      return
    }
    setter(kind)((prev) =>
      prev.map((ch) =>
        ch.id === chapterId
          ? { ...ch, items: ch.items.map((it) => (it.id === itemId ? { ...it, label: text } : it)) }
          : ch,
      ),
    )
    setEditingItem(null)
    setDraft("")
  }

  function deleteItem(kind: "tech" | "business", chapterId: string, itemId: string) {
    setter(kind)((prev) =>
      prev.map((ch) => (ch.id === chapterId ? { ...ch, items: ch.items.filter((it) => it.id !== itemId) } : ch)),
    )
  }

  function addItem(kind: "tech" | "business", chapterId: string) {
    const newId = genId()
    setter(kind)((prev) =>
      prev.map((ch) =>
        ch.id === chapterId
          ? { ...ch, items: [...ch.items, { id: newId, label: "新增子项", isNew: true }] }
          : ch,
      ),
    )
    setEditingChapter(null)
    setEditingItem(newId)
    setDraft("新增子项")
  }

  /* -------- 章节编辑 -------- */
  function startEditChapter(ch: Chapter) {
    setEditingItem(null)
    setEditingChapter(ch.id)
    setDraft(ch.title)
  }

  function saveChapter(kind: "tech" | "business", chapterId: string) {
    const text = draft.trim()
    if (!text) {
      setEditingChapter(null)
      return
    }
    setter(kind)((prev) => prev.map((ch) => (ch.id === chapterId ? { ...ch, title: text } : ch)))
    setEditingChapter(null)
    setDraft("")
  }

  function deleteChapter(kind: "tech" | "business", chapterId: string) {
    setter(kind)((prev) => prev.filter((ch) => ch.id !== chapterId))
  }

  function addChapter(kind: "tech" | "business") {
    setter(kind)((prev) => {
      const newId = genId()
      const no = `第${prev.length + 1}章`
      return [...prev, { id: newId, no, title: "新增章节", sourced: false, items: [] }]
    })
  }

  // 无进行中项目：只引导上传，不渲染任何示例内容
  if (!projectId)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="outline" info={info} />
        <NoProjectGuide />
      </div>
    )

  // 项目数据加载中（含大标书 1MB 级读标结果，拉取要数秒）：先显示加载态——
  // 数据未就绪时绝不裸露计费按钮（用户会当成"还没生成"误触发重跑）。
  if (!info || dataLoading)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="outline" info={info} />
        <StepPlaceholder text="正在加载项目…" delayMs={250} />
      </div>
    )

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <FlowNav current="outline" info={info} />
      {<StepBanner running={running} error={error} runningText={phase ? `AI 编排提纲：${phase.label}…` : "AI 正在基于读标结论搭建技术标/商务标提纲…"} onRetry={() => void start()} action={errorAction ?? undefined} />}
      <StepPageHeader icon={ListTree} title="标书提纲" desc="对齐评分点自动生成投标大纲，可自由增删改，每条均可溯源到招标原文">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <MapPin className="size-3.5" />
              可索引 {indexedCount}
            </span>
            <span className="h-3 w-px bg-border" />
            <span className="inline-flex items-center gap-1 font-medium text-primary">
              <Sparkles className="size-3.5" />
              新增 {newCount}
            </span>
          </div>
          {/* 保存提纲：仅该步有真实 done 结果时可用（否则 PATCH 必 404 step_not_done） */}
          {projectId && real && (
            <div className="flex items-center gap-2">
              {saveState === "error" && <span className="text-xs font-medium text-destructive">{saveError || "保存失败，请重试"}</span>}
              <button
                onClick={() => void saveOutline()}
                disabled={saveState === "saving"}
                className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-70"
              >
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    保存中…
                  </>
                ) : saveState === "saved" ? (
                  <>
                    <Check className="size-4" />
                    已保存
                  </>
                ) : (
                  <>
                    <Save className="size-4" />
                    保存提纲
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      
      </StepPageHeader>
      <AiNotice />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* 左侧：原始文档（真实分句 / 示例回落） */}
        <TenderDocPanel
          fileName={docFileName}
          sections={docSections}
          activeSection={activeSection}
          activeClauses={activeClauses}
          files={readResult?.docFiles}
          registerClauseRef={(id, el) => {
            clauseRefs.current[id] = el
          }}
        />

        {/* 右侧：提纲 */}
        <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
          <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <ListTree className="size-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold text-foreground">投标文件大纲</span>
            <span className="ml-auto text-xs text-muted-foreground">可编辑 · 点击条目定位原文</span>
          </header>

          {/* 标签栏 */}
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "gradient-brand text-white"
                      : "border border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4" />
                  {tab.name}
                </button>
              )
            })}
          </div>

          <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
            {/* 提纲未生成：读标未完成先引导回读标；已就绪则给显式生成按钮（明示消耗），绝不自动跑 */}
            {!real &&
              (running || error ? (
                <StepPlaceholder text={error ? "结果加载异常，请按上方提示重试或刷新" : "提纲生成中…完成后在此展示，可自由增删改"} />
              ) : info?.project.currentStep === "read" ? (
                <StepPlaceholder text="先完成读标步骤，再生成提纲" action={{ href: "/read", label: "前往读标" }} />
              ) : (
                <StepRunCta
                  title="生成投标文件大纲"
                  desc="AI 基于读标结论搭建技术标/商务标提纲，生成后可自由增删改、逐条溯源"
                  costText={`消耗 ${outlineCost} 积分`}
                  actionLabel="生成投标文件大纲"
                  onRun={() => void start()}
                />
              ))}
            <div className="flex flex-col gap-5">
              {(!real ? [] : groups).map((group) => (
                <div key={group.label}>
                  {activeTab === "full" && (
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <span className="rounded-md gradient-brand px-2 py-0.5 text-xs font-semibold text-white">
                        {group.label}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {group.chapters.map((chapter) => (
                      <div key={chapter.id} className="rounded-xl border border-border bg-background p-3">
                        {/* 章节标题行 */}
                        {editingChapter === chapter.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-primary">{chapter.no}</span>
                            <input
                              autoFocus
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveChapter(group.kind, chapter.id)
                                if (e.key === "Escape") setEditingChapter(null)
                              }}
                              className="min-w-0 flex-1 rounded-md border border-primary bg-card px-2 py-1 text-sm font-semibold text-foreground outline-none"
                            />
                            <button
                              onClick={() => saveChapter(group.kind, chapter.id)}
                              className="rounded-md p-1 text-success hover:bg-success/10"
                              aria-label="保存章节标题"
                            >
                              <Check className="size-4" />
                            </button>
                            <button
                              onClick={() => setEditingChapter(null)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                              aria-label="取消"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="group flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-primary">{chapter.no}</span>
                            <h3 className="text-sm font-semibold text-foreground">{chapter.title}</h3>
                            <div className="ml-auto flex items-center gap-0.5">
                              <button
                                onClick={() => startEditChapter(chapter)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-label="编辑章节标题"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button
                                onClick={() => deleteChapter(group.kind, chapter.id)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                aria-label="删除章节"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 子项列表 */}
                        <ul className="mt-2.5 flex flex-col gap-1.5">
                          {chapter.items.map((item) => {
                            const indexed = !!item.clauseIds && item.clauseIds.length > 0
                            const isEditing = editingItem === item.id
                            return (
                              <li key={item.id}>
                                {isEditing ? (
                                  <div className="flex items-center gap-2 rounded-lg border border-primary bg-primary/5 px-2.5 py-1.5">
                                    <ListTree className="size-3.5 shrink-0 text-primary/60" />
                                    <input
                                      autoFocus
                                      value={draft}
                                      onChange={(e) => setDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveItem(group.kind, chapter.id, item.id)
                                        if (e.key === "Escape") setEditingItem(null)
                                      }}
                                      className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                                    />
                                    <button
                                      onClick={() => saveItem(group.kind, chapter.id, item.id)}
                                      className="rounded-md p-1 text-success hover:bg-success/10"
                                      aria-label="保存子项"
                                    >
                                      <Check className="size-4" />
                                    </button>
                                    <button
                                      onClick={() => setEditingItem(null)}
                                      className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                                      aria-label="取消"
                                    >
                                      <X className="size-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <div
                                    className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                                      activeItem === item.id
                                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                                        : indexed
                                          ? "border-transparent hover:border-border hover:bg-muted/60"
                                          : "border-primary/20 bg-primary/5"
                                    }`}
                                  >
                                    <button
                                      onClick={() => handleItemClick(item.clauseIds, item.id)}
                                      disabled={!indexed}
                                      className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                                        indexed ? "cursor-pointer" : "cursor-default"
                                      }`}
                                    >
                                      <ListTree className="size-3.5 shrink-0 text-primary/60" />
                                      <span className="min-w-0 flex-1 truncate text-foreground">{item.label}</span>
                                    </button>
                                    {indexed ? (
                                      /* 定位徽标限宽 45% + 内部截断：条款多时（技术需求可引用 60+ 条）绝不把
                                         条目标题挤出可视区（生产实测）；完整定位见 title 悬浮提示。 */
                                      <span
                                        className="inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success"
                                        title={`定位到 ${locate(item.clauseIds)}`}
                                      >
                                        <MapPin className="size-3 shrink-0" />
                                        <span className="truncate">{locate(item.clauseIds)}</span>
                                      </span>
                                    ) : (
                                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                        <Sparkles className="size-3" />
                                        新增
                                      </span>
                                    )}
                                    <div className="flex shrink-0 items-center gap-0.5">
                                      <button
                                        onClick={() => startEditItem(item)}
                                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                        aria-label="编辑子项"
                                      >
                                        <Pencil className="size-3.5" />
                                      </button>
                                      <button
                                        onClick={() => deleteItem(group.kind, chapter.id, item.id)}
                                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        aria-label="删除子项"
                                      >
                                        <Trash2 className="size-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>

                        {/* 添加子项 */}
                        <button
                          onClick={() => addItem(group.kind, chapter.id)}
                          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                        >
                          <Plus className="size-3.5" />
                          添加子项
                        </button>
                      </div>
                    ))}

                    {/* 添加章节 */}
                    <button
                      onClick={() => addChapter(group.kind)}
                      className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <Plus className="size-4" />
                      添加章节
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* 右下角悬浮：进入正文生成 */}
      <Link
        href="/content"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full gradient-brand px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-opacity hover:opacity-90"
      >
        <CheckCircle2 className="size-4" />
        确认大纲，生成投标正文
        <ArrowRight className="size-4" />
      </Link>
    </div>
  )
}
