"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
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
  Check,
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
import { applyNumbering, buildOutlinePayload, chapterNo, deriveNumberMode, flattenItems, moveChapter, renumberItemsByPosition, type NumberMode } from "@/lib/outline-edit"
import { ChapterItems } from "./chapter-items"
import { OutlineItemDialog } from "./item-dialog"

// agent Outline（camelCase）：chapters[{id,no,title,group,sourced,structureRef?,items[{id,label,clauseIds,isNew}]}]
type RealChapter = BidChapter & { group: "tech" | "business"; structureRef?: string | null; desc?: string }
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
  /** 用户手写的本章写作说明（与子项 desc 同义）：随提纲保存，作为该章写作要求进入正文生成提示词 */
  desc?: string
  items: OutlineItem[]
}

const toOutline = (list: RealChapter[]): Chapter[] =>
  list.map(({ id, no, title, sourced, structureRef, desc, items }) => ({
    id,
    no,
    desc,
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

/** 自动保存防抖：改标题走弹窗（确认才落一次），但连点上移/下移、拖拽排序会在一秒内
 *  产生十几次结构变化。等编辑停下来再发一次，用户几乎察觉不到延迟。 */
const AUTOSAVE_DELAY_MS = 1200

export default function OutlinePage() {
  const router = useRouter()
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
  // 已落盘内容的快照：用来判断「有没有未保存的改动」。用 ref 而非 state——它只参与判断，
  // 不该触发重渲染（每次编辑都重渲染整棵提纲树，代价明显）。
  const savedRef = useRef<string>("")
  useEffect(() => {
    if (!real) return
    const t = toOutline(real.chapters.filter((c) => c.group === "tech"))
    const b = toOutline(real.chapters.filter((c) => c.group === "business"))
    const bf = real.chapters[0]?.group === "business"
    setTechChapters(t)
    setBusinessChapters(b)
    setBizFirst(bf)
    savedRef.current = JSON.stringify(buildOutlinePayload(t, b, bf))
  }, [real])

  // 提纲编辑保存：把当前树序列化回 Outline 形状整份回写（仅该步有真实 done 结果时按钮才出现）
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveError, setSaveError] = useState<string>("")

  /** 存失败的那份内容：自动保存据此避免对同一份内容无限重试（失败→dirty 仍为真→再存→…）。
   *  用户继续编辑后内容变了，就会自动再试一次。 */
  const failedRef = useRef<string>("")

  /** 落盘一次。返回是否成功——调用方（确认跳转）要据此决定还能不能离开本页。 */
  async function persistOutline(): Promise<boolean> {
    if (!projectId) return false
    setSaveState("saving")
    const parts = buildOutlinePayload(techChapters, businessChapters, bizFirst)
    const payload = JSON.stringify(parts)
    try {
      await patchStep(projectId, "outline", { chapters: parts })
      savedRef.current = payload
      failedRef.current = ""
      setSaveState("saved")
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500)
      return true
    } catch (e) {
      // 404 = 该步无真实 done 结果（step_not_done），精确提示而非笼统"保存失败"
      failedRef.current = payload
      setSaveError(patchErrorMessage(e))
      setSaveState("error")
      return false
    }
  }

  async function saveOutline() {
    if (saveState === "saving") return
    await persistOutline()
  }

  /** 当前树与已落盘内容是否不一致（= 有未保存的修改）。
   *  与保存共用 buildOutlinePayload，口径不会漂移。 */
  const dirty =
    !!real && JSON.stringify(buildOutlinePayload(techChapters, businessChapters, bizFirst)) !== savedRef.current
  const [leaveAsk, setLeaveAsk] = useState(false)
  const [going, setGoing] = useState(false)

  /** 「确认大纲，生成投标正文」：先把没落盘的存掉再跳。
   *  存不下就不跳并弹窗说明——跳了改动就真没了，那正是本次要修的丢失。 */
  async function confirmAndGo() {
    if (going) return
    setGoing(true)
    try {
      if (dirty && !(await persistOutline())) {
        setLeaveAsk(true)
        return
      }
      setLeaveAsk(false)
      router.push("/content")
    } finally {
      setGoing(false)
    }
  }

  // 编辑后自动保存（与正文编辑器同一约定）。此前改动只活在前端 state，唯一落盘入口是手动
  // 「保存提纲」，而右下角唯一显眼的按钮「确认大纲，生成投标正文」是纯跳转——用户改完直接点它，
  // 改动当场消失且毫无提示（2026-08-07 用户反馈，实测线上库里那些新增子项一条都不在）。
  // 防抖是必要的：连点上移/下移、拖拽排序会在一秒内产生十几次结构变化，每次都发 PATCH 是浪费。
  useEffect(() => {
    if (!projectId || !dirty || saveState === "saving") return
    // 刚存失败的就是这一份 → 不原地重试（否则 1.2 秒一次打到天荒地老）；用户再改一笔就会重试
    if (JSON.stringify(buildOutlinePayload(techChapters, businessChapters, bizFirst)) === failedRef.current) return
    const timer = setTimeout(() => void persistOutline(), AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persistOutline 每次渲染都是新函数，进依赖会让防抖永远重置
  }, [projectId, dirty, saveState, techChapters, businessChapters, bizFirst])

  // 离开本页时把还没落盘的补发一次。防抖那 1.2 秒里从顶部流程导航切走（next/link 是客户端
  // 跳转，不触发 beforeunload），组件一卸载定时器就被清掉，这笔改动照样丢——正是本次要修的
  // 那种丢失，只是窗口从"一直"缩到了"1.2 秒"。卸载时直接发请求，不走 persistOutline：
  // 组件已经没了，setState 没有意义。
  const pendingRef = useRef<{ projectId: string; parts: unknown[] } | null>(null)
  useEffect(() => {
    pendingRef.current =
      projectId && dirty ? { projectId, parts: buildOutlinePayload(techChapters, businessChapters, bizFirst) } : null
  })
  useEffect(
    () => () => {
      const p = pendingRef.current
      if (p) void patchStep(p.projectId, "outline", { chapters: p.parts }).catch(() => {})
    },
    [],
  )

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

  /* -------- 章节编辑（标题 + 序号 + 写作说明，走弹窗） -------- */
  // 章标题编辑与子项编辑互斥（评审二轮:重构曾丢互斥）——bump 让所有 ChapterItems 收敛编辑态
  const [itemEditReset, setItemEditReset] = useState(0)
  function startEditChapter(kind: "tech" | "business", ch: Chapter) {
    setItemEditReset((n) => n + 1)   // 与子项编辑互斥：同时开两处会让用户分不清在改哪个
    setChapterDialog({ mode: "edit", kind, chapter: ch })
  }

  function saveChapter(kind: "tech" | "business", chapterId: string, title: string, desc: string, no: string) {
    const text = title.trim()
    if (!text) return
    setter(kind)((prev) =>
      prev.map((ch) => (ch.id === chapterId ? { ...ch, title: text, desc, no: no.trim() || ch.no } : ch)),
    )
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

  /* 章节的新增与编辑都走弹窗，与子项同一套表单：标题 + 写作说明（编辑时多一个章节编号栏）。
     此前新增是插占位再改名、编辑是行内改名+改编号，写作说明无处可填。 */
  const [chapterDialog, setChapterDialog] = useState<
    { mode: "add"; kind: "tech" | "business" }
    | { mode: "edit"; kind: "tech" | "business"; chapter: Chapter }
    | null
  >(null)
  function addChapter(kind: "tech" | "business", title: string, desc: string) {
    const cur = { tech: techChapters, business: businessChapters }
    const added = { id: genId(), no: chapterNo(cur[kind].length + 1), title, desc, sourced: false, items: [] }
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
              {/* 状态要说实话：防抖那一秒里还没落盘，此时写「编辑后自动保存」等于给用户一个
                  错误的安全感（复核指出的问题）。失败更要说——否则用户以为存好了就走人。 */}
              {saveState === "error" ? (
                <span className="text-xs font-medium text-destructive">{saveError || "自动保存失败，请点保存重试"}</span>
              ) : dirty && saveState !== "saving" ? (
                <span className="text-xs font-medium text-primary">待保存…</span>
              ) : (
                <span className="text-xs text-muted-foreground">编辑后自动保存</span>
              )}
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
                              onClick={() => startEditChapter(group.kind, chapter)}
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

                        {/* 子项树（节/小节两层:编辑/删除/添加小节/同层拖拽,评审需求） */}
                        <ChapterItems
                          items={chapter.items}
                          activeItem={activeItem}
                          locate={locate}
                          onItemClick={handleItemClick}
                          genId={genId}
                          onEditStart={() => setChapterDialog(null)}   // 与章节弹窗互斥，同时开两处用户分不清在改哪个
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
                      onClick={() => setChapterDialog({ mode: "add", kind: group.kind })}
                      aria-label="添加章节"
                      title="添加章节"
                      className="flex items-center justify-center rounded-xl border border-dashed border-border py-2.5 text-lg leading-none text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <span aria-hidden>➕</span>
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
        <button
          onClick={() => void confirmAndGo()}
          disabled={going}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full gradient-brand px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-70"
        >
          {going ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          确认大纲，生成投标正文
          <ArrowRight className="size-4" />
        </button>
      )}

      {/* 只在**保存失败**时出现。正文按库里的提纲生成，此时放行等于用户改的标题、加的子项
          全部作废，事后回提纲页也看不到（2026-08-07 用户反馈的正是这一幕），所以宁可拦住。
          保存成功/仍在防抖窗口这两种常态不弹窗——confirmAndGo 会先存好再跳。 */}
      {leaveAsk && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={() => setLeaveAsk(false)} aria-hidden />
          <div role="dialog" aria-modal="true" className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold text-foreground">提纲没能保存，暂时不能生成正文</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              正文按已保存的提纲生成。这次改的标题和新增的子项还没存上，现在生成不会生效，也不会保留。
            </p>
            <p className="mt-2 text-sm font-medium text-destructive">{saveError || "保存失败，请重试"}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setLeaveAsk(false)}
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                返回继续编辑
              </button>
              <button
                disabled={going}
                onClick={() => void confirmAndGo()}
                className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-70"
              >
                {going ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                重试保存并生成
              </button>
            </div>
          </div>
        </div>
      )}

      {chapterDialog && (
        <OutlineItemDialog
          mode={chapterDialog.mode}
          levelName="章节"
          initialLabel={chapterDialog.mode === "edit" ? chapterDialog.chapter.title : ""}
          initialDesc={chapterDialog.mode === "edit" ? (chapterDialog.chapter.desc ?? "") : ""}
          // 编辑时才给编号栏：新增的编号按当前章数自动排，不必让用户填
          initialNo={chapterDialog.mode === "edit" ? chapterDialog.chapter.no : undefined}
          onCancel={() => setChapterDialog(null)}
          onConfirm={(title, desc, no) => {
            if (chapterDialog.mode === "add") addChapter(chapterDialog.kind, title, desc)
            else saveChapter(chapterDialog.kind, chapterDialog.chapter.id, title, desc, no ?? "")
            setChapterDialog(null)
          }}
        />
      )}
    </div>
  )
}
