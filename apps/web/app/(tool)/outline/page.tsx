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
  ChevronUp,
  ChevronDown,
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
import { stepNotApplicable, useStep, useOtherStepResult } from "@/lib/use-step"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { patchErrorMessage, patchStep } from "@/lib/project"
import { clauseLocationIn, groupDocSections, type DocSentence } from "@/lib/doc-sections"
import { applyNumbering, chapterNo, deriveNumberMode, flattenItems, moveChapter, renumberItemsByPosition, serializeItems, type NumberMode } from "@/lib/outline-edit"
import { ChapterItems } from "./chapter-items"

// agent Outline（camelCase）：chapters[{id,no,title,group,sourced,structureRef?,items[{id,label,clauseIds,isNew}]}]
type RealChapter = BidChapter & { group: "tech" | "business"; structureRef?: string | null }
type RealOutline = { chapters: RealChapter[] }

/* ---------------- 提纲数据（取自全流程共享数据源） ---------------- */
type Chapter = {
  id: string
  no: string
  title: string
  /** 是否能在招标文件中索引到来源（保存回写 Outline 契约需要） */
  sourced: boolean
  /** 对应投标文件构成项 id（spec321/322 偏离表与格式模板按它匹配）——编辑保存必须透传，丢了匹配会退化 */
  structureRef?: string | null
  items: OutlineItem[]
}

const toOutline = (list: RealChapter[]): Chapter[] =>
  list.map(({ id, no, title, sourced, structureRef, items }) => ({
    id,
    no,
    title,
    sourced,
    structureRef,
    items: items.map((it) => ({ ...it, children: (it.children ?? []).map((c) => ({ ...c })) })),
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
  // 组顺序（用户需求：部分标书要求商务标在前）：chapters 数组顺序是唯一真相——保存/导出/
  // 正文页都按它走；这里从已存结果的首章分组还原，切换后点「保存提纲」持久化。
  const [bizFirst, setBizFirst] = useState(false)
  useEffect(() => {
    if (!real) return
    setTechChapters(toOutline(real.chapters.filter((c) => c.group === "tech")))
    setBusinessChapters(toOutline(real.chapters.filter((c) => c.group === "business")))
    setBizFirst(real.chapters[0]?.group === "business")
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
        structureRef: ch.structureRef ?? null,
        items: serializeItems(ch.items),
      }))
    try {
      // 数组顺序即成书顺序（导出/正文页跟随）：按当前组顺序拼接
      const parts = bizFirst
        ? [...serialize(businessChapters, "business"), ...serialize(techChapters, "tech")]
        : [...serialize(techChapters, "tech"), ...serialize(businessChapters, "business")]
      await patchStep(projectId, "outline", { chapters: parts })
      setSaveState("saved")
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500)
    } catch (e) {
      // 404 = 该步无真实 done 结果（step_not_done），精确提示而非笼统"保存失败"
      setSaveError(patchErrorMessage(e))
      setSaveState("error")
    }
  }

  // 正在编辑的目标：条目或章节标题
  const [editingChapter, setEditingChapter] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // 组显示顺序（全文视图/编号/保存共用）
  const groupSeq: { label: string; kind: "tech" | "business"; chapters: Chapter[] }[] = [
    { label: "技术标", kind: "tech", chapters: techChapters },
    { label: "商务标", kind: "business", chapters: businessChapters },
  ]
  if (bizFirst) groupSeq.reverse()

  // 当前标签对应的分组
  const groups: { label: string; kind: "tech" | "business"; chapters: Chapter[] }[] =
    activeTab === "tech"
      ? [{ label: "技术标", kind: "tech", chapters: techChapters }]
      : activeTab === "business"
        ? [{ label: "商务标", kind: "business", chapters: businessChapters }]
        : groupSeq

  const allItems = groups.flatMap((g) => g.chapters).flatMap((c) => flattenItems(c.items))
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

  /* 条目编辑/增删/拖拽已内聚到 ChapterItems 组件（三级提纲,评审需求） */

  /* -------- 章节编辑（标题 + 序号都可改） -------- */
  const [noDraft, setNoDraft] = useState("")
  // 章标题编辑与子项编辑互斥（评审二轮:重构曾丢互斥）——bump 让所有 ChapterItems 收敛编辑态
  const [itemEditReset, setItemEditReset] = useState(0)
  function startEditChapter(ch: Chapter) {
    setItemEditReset((n) => n + 1)
    setEditingChapter(ch.id)
    setDraft(ch.title)
    setNoDraft(ch.no)
  }

  function saveChapter(kind: "tech" | "business", chapterId: string) {
    const text = draft.trim()
    if (!text) {
      setEditingChapter(null)
      return
    }
    const no = noDraft.trim()
    setter(kind)((prev) =>
      prev.map((ch) => (ch.id === chapterId ? { ...ch, title: text, no: no || ch.no } : ch)),
    )
    setEditingChapter(null)
    setDraft("")
    setNoDraft("")
  }

  /** 结构变化（增/删/移动/换组顺序）后的统一落地：原编号严格符合某模式（连续/分组）就按该模式
   *  自动重排（章号 + 子项层级编号一起跟随，中间插入才不会出现两个"第五章"）；用户自定义过
   *  编号（custom）则一律不动。只改本地状态，点「保存提纲」持久化。 */
  function commitStructure(next: { tech: Chapter[]; business: Chapter[] }, nextBizFirst = bizFirst) {
    const order: ("tech" | "business")[] = nextBizFirst ? ["business", "tech"] : ["tech", "business"]
    const prevOrder: ("tech" | "business")[] = bizFirst ? ["business", "tech"] : ["tech", "business"]
    const cur = { tech: techChapters, business: businessChapters }
    const mode = deriveNumberMode(prevOrder.map((g) => cur[g]))
    if (mode !== "custom") {
      const renumbered = applyNumbering(order.map((g) => next[g]), mode)
      next = { ...next, [order[0]!]: renumbered[0]!, [order[1]!]: renumbered[1]! }
    }
    setBizFirst(nextBizFirst)
    setTechChapters(next.tech)
    setBusinessChapters(next.business)
  }

  function deleteChapter(kind: "tech" | "business", chapterId: string) {
    const cur = { tech: techChapters, business: businessChapters }
    commitStructure({ ...cur, [kind]: cur[kind].filter((ch) => ch.id !== chapterId) })
  }

  function addChapter(kind: "tech" | "business") {
    const cur = { tech: techChapters, business: businessChapters }
    const added = { id: genId(), no: chapterNo(cur[kind].length + 1), title: "新增章节", sourced: false, items: [] }
    commitStructure({ ...cur, [kind]: [...cur[kind], added] })
  }

  /** 组内上移/下移章节（用户需求：可在任意两章之间插入/调整顺序） */
  function moveChapterIn(kind: "tech" | "business", chapterId: string, dir: -1 | 1) {
    const cur = { tech: techChapters, business: businessChapters }
    commitStructure({ ...cur, [kind]: moveChapter(cur[kind], chapterId, dir) })
  }

  /** 组顺序切换（用户需求：部分标书要求商务标在前）；连续编号跟随新顺序重排 */
  function setGroupOrder(nextBizFirst: boolean) {
    if (nextBizFirst === bizFirst) return
    commitStructure({ tech: techChapters, business: businessChapters }, nextBizFirst)
  }

  /** 一键重排章节编号（用户需求：部分标书要求全文从第一章顺到底，而默认技术/商务各自从第一章起）。
   *  continuous=按当前组顺序全文连续；grouped=两组各自从第一章。子项层级编号首段一起跟随。 */
  function renumber(mode: NumberMode) {
    const order: ("tech" | "business")[] = bizFirst ? ["business", "tech"] : ["tech", "business"]
    const cur = { tech: techChapters, business: businessChapters }
    const renumbered = applyNumbering(order.map((g) => cur[g]), mode)
    setTechChapters(renumbered[order.indexOf("tech")]!)
    setBusinessChapters(renumbered[order.indexOf("business")]!)
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

  // 章节编号当前模式（派生自实际编号，不引入独立状态）：严格匹配连续/分组序列才算，
  // 否则视为用户自定义（custom，两个按钮都不高亮、结构变化不自动改写编号）。
  const numberMode = deriveNumberMode((bizFirst ? [businessChapters, techChapters] : [techChapters, businessChapters]))

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
            {/* 组顺序 + 一键重排章节编号（改完点「保存提纲」持久化） */}
            {real && (
              <span className="ml-auto inline-flex flex-wrap items-center gap-3">
                {/* 组顺序切换（部分标书要求商务标在前）：数组顺序即成书顺序，导出/正文页跟随 */}
                {techChapters.length > 0 && businessChapters.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    组顺序
                    <button
                      onClick={() => setGroupOrder(false)}
                      aria-pressed={!bizFirst}
                      title="技术标在前、商务标在后；改完点「保存提纲」生效"
                      className={`rounded-md px-2 py-1 font-medium transition-colors ${
                        !bizFirst ? "gradient-brand text-white" : "border border-border bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      技术标在前
                    </button>
                    <button
                      onClick={() => setGroupOrder(true)}
                      aria-pressed={bizFirst}
                      title="商务标在前、技术标在后（部分标书要求）；改完点「保存提纲」生效"
                      className={`rounded-md px-2 py-1 font-medium transition-colors ${
                        bizFirst ? "gradient-brand text-white" : "border border-border bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      商务标在前
                    </button>
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  章节编号
                  <button
                    onClick={() => renumber("continuous")}
                    aria-pressed={numberMode === "continuous"}
                    title="按当前组顺序全文从第一章连续编号（部分标书要求）；改完点「保存提纲」生效"
                    className={`rounded-md px-2 py-1 font-medium transition-colors ${
                      numberMode === "continuous"
                        ? "gradient-brand text-white"
                        : "border border-border bg-card text-foreground hover:bg-muted"
                    }`}
                  >
                    全文连续
                  </button>
                  <button
                    onClick={() => renumber("grouped")}
                    aria-pressed={numberMode === "grouped"}
                    title="技术标 / 商务标各自从第一章编号；改完点「保存提纲」生效"
                    className={`rounded-md px-2 py-1 font-medium transition-colors ${
                      numberMode === "grouped"
                        ? "gradient-brand text-white"
                        : "border border-border bg-card text-foreground hover:bg-muted"
                    }`}
                  >
                    分组各自
                  </button>
                </span>
              </span>
            )}
          </div>

          <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
            {/* 提纲未生成：读标未完成先引导回读标；已就绪则给显式生成按钮（明示消耗），绝不自动跑 */}
            {!real &&
              (running || error ? (
                <StepPlaceholder text={error ? "结果加载异常，请按上方提示重试或刷新" : "提纲生成中…完成后在此展示，可自由增删改"} />
              ) : info?.project.currentStep === "read" ? (
                <StepPlaceholder text="先完成读标步骤，再生成提纲" action={{ href: "/read", label: "前往读标" }} />
              ) : stepNotApplicable(info, "outline") ? (
                /* 审查专用项目（spec328）没有提纲步:渲染引导而非计费 CTA（点了必 409） */
                <StepPlaceholder text="本项目为「标书审查」专用,不含提纲/正文生成" action={{ href: "/risk", label: "前往标书审查" }} />
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
                    {group.chapters.map((chapter, chapterIdx) => (
                      <div key={chapter.id} className="rounded-xl border border-border bg-background p-3">
                        {/* 章节标题行 */}
                        {editingChapter === chapter.id ? (
                          <div className="flex items-center gap-2">
                            {/* 序号可编辑（用户需求：部分标书要求自定义章节编号） */}
                            <input
                              value={noDraft}
                              onChange={(e) => setNoDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveChapter(group.kind, chapter.id)
                                if (e.key === "Escape") setEditingChapter(null)
                              }}
                              placeholder="第一章"
                              className="w-20 shrink-0 rounded-md border border-primary bg-card px-2 py-1 text-xs font-medium text-primary outline-none"
                            />
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
                              {/* 组内上移/下移（在任意两章之间插入=新增后上移到位）；编号按当前模式自动跟随 */}
                              <button
                                onClick={() => moveChapterIn(group.kind, chapter.id, -1)}
                                disabled={chapterIdx === 0}
                                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                                aria-label="上移章节"
                              >
                                <ChevronUp className="size-3.5" />
                              </button>
                              <button
                                onClick={() => moveChapterIn(group.kind, chapter.id, 1)}
                                disabled={chapterIdx === group.chapters.length - 1}
                                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                                aria-label="下移章节"
                              >
                                <ChevronDown className="size-3.5" />
                              </button>
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

                        {/* 子项树（节/小节两层:编辑/删除/添加小节/同层拖拽,评审需求） */}
                        <ChapterItems
                          items={chapter.items}
                          activeItem={activeItem}
                          locate={locate}
                          onItemClick={handleItemClick}
                          genId={genId}
                          onEditStart={() => setEditingChapter(null)}
                          closeEditToken={itemEditReset}
                          onChange={(items) =>
                            // 结构性修改（拖拽/增删）后按位置重排层级编号（评审二轮 F6:1.2 排 1.1 前）
                            setter(group.kind)((prev) =>
                              prev.map((ch) => (ch.id === chapter.id ? { ...ch, items: renumberItemsByPosition(items) } : ch)),
                            )
                          }
                        />
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

      {/* 右下角悬浮：进入正文生成。**没有提纲就不该有这个按钮**——
          审查专用项目页面上明写着「不含提纲/正文生成」，右下角却还挂着「确认大纲，生成投标正文」，
          自相矛盾（用户反馈：逻辑混乱）；提纲尚未生成的普通项目同理，没什么「大纲」可确认。 */}
      {real && !stepNotApplicable(info, "outline") && (
        <Link
          href="/content"
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full gradient-brand px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-opacity hover:opacity-90"
        >
          <CheckCircle2 className="size-4" />
          确认大纲，生成投标正文
          <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  )
}
