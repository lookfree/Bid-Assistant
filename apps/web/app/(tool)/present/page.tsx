"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Presentation,
  Clock,
  Palette,
  Plus,
  Trash2,
  GripVertical,
  MessageSquareText,
  HelpCircle,
  FileDown,
  X,
  ChevronRight,
  History,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { CreditEstimate } from "@/components/credit-estimate"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { StepBanner } from "@/components/tool/step-banner"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { useLibrary } from "@/lib/use-library"
import { createEntry } from "@/lib/library-api"
import { uploadFile } from "@/lib/files"
import {
  estimateMinutes,
  slideStyles,
  enterpriseTemplateStyle,
  type Slide,
  type StyleId,
  type SlideStyle,
} from "@/lib/present"
import { LibraryPicker } from "@/components/tool/library-picker"
import { AiNotice } from "@/components/tool/ai-notice"
import { type LibraryItem } from "@/lib/library"
import { ApiError } from "@/lib/api-client"
import { storedFormat } from "@/lib/generation-config"
import { stepPrereq, useStep } from "@/lib/use-step"
import { artifactDownload, triggerDownload, patchErrorMessage, patchStep, runStep } from "@/lib/project"
import { AiPanel } from "./ai-panel"
import { EmptyState, DURATIONS, type Duration } from "./empty-state"
import { TemplatePicker } from "./template-picker"
import { SlidePreview } from "./slide-preview"
import { PresentEntry } from "./present-entry"

// agent DeckSpec（camelCase）：slides/qa 与原型 Slide/QA 同构
type RealDeck = { title: string; duration: number; template: string; slides: Slide[]; qa: { q: string; a: string }[] }

export default function PresentPage() {
  const { openPaywall } = usePaywall()
  const router = useRouter()

  /* 真实积分余额与会员身份（GET /api/membership；仅 active 订阅算会员权益） */
  const { overview, balance, isMember, loading: membershipLoading, error: membershipError } = useMembership()
  /* 计费口径一律取后端实时配置（运营可改），勿用静态副本——否则显示与实际扣减不一致 */
  const exportCost = creditCostValue(overview, "export", 20)
  const canAfford = balance >= exportCost
  /* 述标生成计费口径（优先后端实时配置） */
  const presentCost = creditCostValue(overview, "present", 80)
  /* 资料库数据提升到页面级：LibraryPicker / TemplatePicker 共用同一份，避免同页重复拉取 */
  const { items: libItems, loading: libLoading, error: libError, reload: reloadLibrary } = useLibrary()
  /* 有当前项目就**直连它的述标生成卡**（用户要求）：不再先过一道「选项目/传标书」的中转页——
     选别的标书是次要动作，入口做在卡片里（EmptyState 的「从我的标书选择 / 上传标书文件」，
     跳 ?view=entry）。?view=project 是历史链接，等价于默认行为，继续兼容。
     本组件在 RequireAuth 之后才客户端挂载，惰性读 URL 参数无 SSR 水合问题。 */
  const [viewParam] = useState(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view")),
  )

  /* 配置 */
  const [duration, setDuration] = useState<Duration>(15)
  const [styleId, setStyleId] = useState<StyleId>("blue")
  /* 模板与参考（会员权益） */
  const [tplOpen, setTplOpen] = useState(false)
  const [enterpriseStyle, setEnterpriseStyle] = useState<SlideStyle | null>(null)
  const [refPpt, setRefPpt] = useState<string | null>(null)
  /* 当前套用的企业模板对应的资料库条目 id（present 步 run body 的 enterpriseTemplateItemId）；
     选内置预设时清空——只有真正选中「企业自有模板」才带这个键。 */
  const [enterpriseItemId, setEnterpriseItemId] = useState<string | null>(null)

  /* 幻灯编辑状态（present 步结果到位后填充） */
  const [slides, setSlides] = useState<Slide[]>([])
  const [activeId, setActiveId] = useState<string>("")

  /* 交互 */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState("")
  /* 402 积分不足等需要引导入口的导出错误：文案 + 链接（不随 3 秒自动消失） */
  const [exportGate, setExportGate] = useState<{ text: string; href: string; label: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  /* present 步产 DeckSpec（真实幻灯+口播稿）。计费步：绝不自动触发，
     只由用户点击「生成述标大纲」（CreditEstimate 确认条，明示消耗）才跑，
     生成调用透传当前时长/模板（POST steps/present body {duration, template}）。 */
  const { projectId, info, data: realDeck, dataLoading, running: stepRunning, phase, error: stepError, errorAction: stepErrorAction, start } = useStep<RealDeck>("present")
  useEffect(() => {
    if (!realDeck) return
    setSlides(realDeck.slides)
    setActiveId(realDeck.slides[0]?.id ?? "")
    // 选择器与后端已存 deck 对齐（保存/下次生成据此透传）
    if (DURATIONS.includes(realDeck.duration as Duration)) setDuration(realDeck.duration as Duration)
    if (slideStyles.some((s) => s.id === realDeck.template)) setStyleId(realDeck.template as StyleId)
  }, [realDeck])
  /* 只有显式 ?view=entry（卡片里的两个次要入口）或压根没有当前项目，才去独立入口页 */
  const enterProject = viewParam !== "entry" && !!projectId

  /* deck 就绪 = present 步已有真实结果（编辑/保存/导出入口只在此后出现） */
  const hasDeck = !!realDeck
  /* 用户口径：菜单点进来一律先看生成卡；本项目已有述标时卡上给一个跳转链接。
     只有显式 ?view=deck（点了那个链接）或**本次刚生成完**才直接进结果页——刚付过钱的人
     当然要立刻看到成品，但从菜单进来不该跳过那张卡（它同时是换标书/改时长模板的入口）。 */
  const [deckView, setDeckView] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "deck",
  )
  const generatedHere = useRef(false)
  useEffect(() => {
    if (realDeck && generatedHere.current) setDeckView(true)
  }, [realDeck])
  const deckReady = hasDeck && deckView

  /* 当前预览样式：套用企业模板时优先，否则用内置预设 */
  const style = enterpriseStyle ?? slideStyles.find((s) => s.id === styleId)!
  const active = slides.find((s) => s.id === activeId)
  const estMin = useMemo(() => estimateMinutes(slides), [slides])

  /* 选内置预设：清除企业模板套用 */
  function pickBuiltin(id: StyleId) {
    setStyleId(id)
    setEnterpriseStyle(null)
    setEnterpriseItemId(null)
    setTplOpen(false)
  }
  /* 会员权益 gate：会员信息加载中不判定（防按未登录口径误跳），非会员跳会员页 */
  function ensureMember(): boolean {
    if (membershipLoading) return false
    if (!isMember) {
      router.push("/membership")
      return false
    }
    return true
  }
  /* 套用已有的企业模板资料库条目：会员专享（进选择器前已 gate，这里兜底一次） */
  function pickEnterprise(s: SlideStyle, itemId: string) {
    if (!ensureMember()) return
    setEnterpriseStyle(s)
    setEnterpriseItemId(itemId)
    setTplOpen(false)
  }
  function pickReference(name: string) {
    if (!ensureMember()) return
    setRefPpt(name)
  }
  /* 上传企业 PPT 母版（.pptx/.potx）：真实直传 MinIO 后落资料库 presentation 分类条目
     （企业模板 tags 契约，与已有条目同一批次筛选逻辑），并立即选中套用该模板。 */
  async function uploadTemplate(file: File) {
    const uploaded = await uploadFile(file)
    const entry = await createEntry({
      category: "presentation",
      tags: ["企业模板"],
      title: file.name,
      attachments: [uploaded],
    })
    await reloadLibrary()
    setEnterpriseStyle(enterpriseTemplateStyle(entry.id, entry.title))
    setEnterpriseItemId(entry.id)
    setTplOpen(false)
  }
  /* 上传参考历史述标 PPT：真实直传 MinIO 后入资料库（历史述标 tags 契约），并设为本次参考 */
  async function uploadReference(file: File) {
    const uploaded = await uploadFile(file)
    await createEntry({
      category: "presentation",
      tags: ["历史述标"],
      title: file.name,
      attachments: [uploaded],
    })
    await reloadLibrary()
    setRefPpt(file.name)
  }

  /* present 步 run body：企业模板选中时（非内置三款预设）附带 enterpriseTemplateItemId，
     后端据此解析出 MinIO key 传给 agent 套用客户自有母版。 */
  function presentRunBody(): Record<string, unknown> {
    return { duration, template: styleId, ...(enterpriseItemId ? { enterpriseTemplateItemId: enterpriseItemId } : {}) }
  }
  /* ---------------- 生成大纲（用户显式点击才跑，透传当前时长/模板） ---------------- */
  function runGenerate() {
    generatedHere.current = true
    void start(presentRunBody())
  }

  /* 切换时长：只更新选择器（新时长随下次生成透传，或经「保存」回写 deck.duration，
     绝不静默重跑生成，避免误触重复扣积分） */
  function changeDuration(d: Duration) {
    setDuration(d)
  }

  /* ---------------- 幻灯片编辑 ---------------- */
  function updateSlide(id: string, patch: Partial<Slide>) {
    setSlides((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  function updateBullet(id: string, idx: number, value: string) {
    setSlides((prev) =>
      prev.map((s) => (s.id === id ? { ...s, bullets: s.bullets.map((b, i) => (i === idx ? value : b)) } : s)),
    )
  }
  function addBullet(id: string) {
    setSlides((prev) => prev.map((s) => (s.id === id ? { ...s, bullets: [...s.bullets, "新的要点"] } : s)))
  }
  function removeBullet(id: string, idx: number) {
    setSlides((prev) =>
      prev.map((s) => (s.id === id ? { ...s, bullets: s.bullets.filter((_, i) => i !== idx) } : s)),
    )
  }
  function addSlide() {
    const id = `s-${Date.now()}`
    const newSlide: Slide = {
      id,
      title: "新页面",
      scoring: "自定义页",
      kind: "content",
      bullets: ["请输入要点"],
      notes: "请输入本页演讲备注。",
    }
    const idx = slides.findIndex((s) => s.id === activeId)
    const next = [...slides]
    next.splice(idx >= 0 ? idx + 1 : slides.length, 0, newSlide)
    setSlides(next)
    setActiveId(id)
  }
  function deleteSlide(id: string) {
    const idx = slides.findIndex((s) => s.id === id)
    const next = slides.filter((s) => s.id !== id)
    setSlides(next)
    if (activeId === id && next.length) setActiveId(next[Math.max(0, idx - 1)].id)
  }

  /* 拖动排序 */
  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return
    const from = slides.findIndex((s) => s.id === dragId)
    const to = slides.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...slides]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setSlides(next)
    setDragId(null)
  }

  /* ---------------- 资料库插入 ---------------- */
  function insertFromLibrary(item: LibraryItem) {
    if (!active) return
    let bullet = item.title
    if (item.meta) bullet += `（${item.meta}）`
    else if (item.fields?.length) bullet += `（${item.fields.map((f) => `${f.label}${f.value}`).join("，")}）`
    updateSlide(active.id, { bullets: [...active.bullets, bullet] })
    setLibraryOpen(false)
  }

  /* ---------------- 保存幻灯片编辑 ---------------- */
  /* 把当前 deck（编辑后的幻灯 + 选择器时长/模板）序列化回 DeckSpec 整份回写 present 步结果；
     导出（export 步）由后端自动带编辑后 deck 重渲 pptx。 */
  const [deckSaveState, setDeckSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [deckSaveError, setDeckSaveError] = useState<string>("")
  async function saveDeck() {
    if (!projectId || !realDeck || deckSaveState === "saving") return
    setDeckSaveState("saving")
    try {
      await patchStep(projectId, "present", {
        title: realDeck.title,
        duration,
        template: styleId,
        slides,
        qa: realDeck.qa,
      })
      setDeckSaveState("saved")
      setTimeout(() => setDeckSaveState((s) => (s === "saved" ? "idle" : s)), 2500)
    } catch (e) {
      // 404 = 该步无真实 done 结果（step_not_done），精确提示
      setDeckSaveError(patchErrorMessage(e))
      setDeckSaveState("error")
    }
  }

  /* 预计问答：deck 生成的 QA；缺失则不渲染问答卡 */
  const qaList = realDeck?.qa ?? []

  /* 导出在途（含产物整理的付费 export 步）：按钮置灰防重——在途仍可点是怪设计（用户反馈） */
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)

  /* ---------------- 导出 ---------------- */
  function onExportEntry() {
    // 余额加载中不做付费墙判定（按钮已禁用，双保险防按 balance=0 误弹）
    if (membershipLoading || exportingRef.current) return
    setExportGate(null)
    if (!canAfford) {
      openPaywall("present")
      return
    }
    setExportOpen((v) => !v)
  }
  function doExport(_format: "pptx" | "pdf") {
    setExportOpen(false)
    setExportGate(null)
    if (exportingRef.current) return // 同步防重：在途时忽略重复触发
    // 只有真实项目产物可导出（导出按钮无项目时已禁用；此处兜底提示）
    if (!projectId || !realDeck) {
      setExportStatus("请先从项目进入并生成述标演示，再导出")
      setTimeout(() => setExportStatus(""), 3000)
      return
    }
    // 步序闸守卫（defensive）：present 完成后 currentStep=export，一般已放行；
    // 未到 export/done 就不调 runStep("export")（后端必 409），给友好提示
    const cur = info?.project.currentStep
    if (cur && cur !== "export" && cur !== "done") {
      setExportStatus("述标生成完成后才能导出，请先完成本步生成")
      setTimeout(() => setExportStatus(""), 3000)
      return
    }
    // 真实导出：present 步已把 .pptx 落 MinIO，取预签名 URL 直下
    exportingRef.current = true
    setExporting(true)
    setExportStatus("正在获取下载链接…")
    void (async () => {
      try {
        let dl: { url: string; filename: string }
        try {
          dl = await artifactDownload(projectId, "pptx")
        } catch (e) {
          // 仅 404（产物不存在=从未跑过 export）才触发计费的 export 步；瞬断/5xx 一律如实报错——
          // 计费红线：重复下载免费，绝不能因网络抖动静默重跑付费步骤。
          if (!(e instanceof ApiError && e.status === 404)) throw e
          setExportStatus("正在整理产物…")
          // 审查修正：回退重渲也带用户存好的输出格式,否则会把定制版式的 docx/pdf 覆盖回默认版式
          const fmt = storedFormat()
          await runStep(projectId, "export", undefined, fmt ? { format: fmt } : undefined)
          dl = await artifactDownload(projectId, "pptx")
        }
        triggerDownload(dl.url)
        setExportStatus(`已开始下载《${dl.filename}》，可在浏览器「下载」列表查看`)
      } catch (e) {
        // 错误码直通：402 引导充值（持久提示），409 步骤顺序，其余通用重试
        if (e instanceof ApiError && e.status === 402) {
          setExportGate({ text: "积分不足，无法导出", href: "/membership", label: "去充值" })
          setExportStatus("")
        } else if (e instanceof ApiError && e.status === 409) {
          setExportStatus("步骤顺序不符，请先完成前序步骤")
        } else {
          setExportStatus("下载失败，请重试")
        }
      } finally {
        exportingRef.current = false
        setExporting(false)
        setTimeout(() => setExportStatus(""), 6000) // 成功提示含文件名，3 秒读不完
      }
    })()
  }

  // 独立入口页：只有用户从卡片里点了「从我的标书选择 / 上传标书文件」（?view=entry），
  // 或压根没有当前项目时才到这里。「返回当前项目的述标」仅在当前项目确可述标时给出——
  // 否则不给，避免对未就绪项目给一个点了会空转回入口的死链。
  if (!enterProject || !projectId)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="present" info={info} />
        <StepPageHeader icon={Presentation} title="述标演示" desc="一键把标书提炼成述标/答辩 PPT，含演讲备注与预计问答" />
        {!projectId && (
          <p className="mb-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground">
            还没有选中的标书——先从下面选一份（或上传线下标书），选完就直接进入述标生成页。
          </p>
        )}
        <PresentEntry
          onBack={projectId && info && !stepPrereq(info, "present") ? () => { window.location.href = "/present?view=project" } : undefined}
        />
      </div>
    )

  // 项目数据加载中（含大标书 1MB 级读标结果，拉取要数秒）：先显示加载态——
  // 数据未就绪时绝不裸露计费按钮（用户会当成"还没生成"误触发重跑）。
  if (!info || dataLoading)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="present" info={info} />
        <StepPlaceholder text={dataLoading ? "正在加载述标数据…" : "正在加载项目…"} delayMs={250} />
      </div>
    )

  // 当前项目还不能述标（正文没生成完）：**仍然停在这张卡上**，说清楚差哪一步、给一键前往，
  // 并保留「从我的标书选择 / 上传标书文件」两个次要入口。原来直接甩回选择页——用户从菜单点进来
  // 看到的是一个完全不同的页面（反馈：莫名其妙又出现这种页面）。此时不渲染任何计费按钮。
  const gap = realDeck ? null : stepPrereq(info, "present")
  if (gap)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="present" info={info} />
        <StepPageHeader icon={Presentation} title="述标演示" desc="一键把标书提炼成述标/答辩 PPT，含演讲备注与预计问答" />
        <NotReadyCard projectName={info.project.name ?? "当前项目"} gap={gap} />
      </div>
    )

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* 流程返回区：上一步 + 面包屑 + 与其他工具页统一的卡片式标题栏 */}
      <div className="shrink-0 px-4 pt-4 pb-4 sm:px-6">
        <FlowNav current="present" info={info} />
        <StepBanner
          running={stepRunning}
          error={stepError}
          runningText={phase ? `${phase.label}…` : "AI 正在基于标书与评分点生成述标稿与 PPT…"}
          onRetry={() => void start(presentRunBody())}
          action={stepErrorAction ?? undefined}
        />
        <StepPageHeader icon={Presentation} title="述标演示" desc="一键把标书提炼成述标/答辩 PPT，含演讲备注与预计问答">
          {deckReady && (
            <div className="flex flex-wrap items-center gap-2">
              {/* 时长适配 */}
              <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-0.5">
                <Clock className="ml-1.5 size-3.5 text-muted-foreground" />
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => changeDuration(d)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      duration === d ? "gradient-brand text-white" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {d} 分钟
                  </button>
                ))}
              </div>
              {/* 模板 / 风格 */}
              <button
                onClick={() => setTplOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary/40"
              >
                <Palette className="size-3.5 text-muted-foreground" />
                <span className={`size-2.5 rounded-full ${style.swatch}`} />
                {style.name}
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </button>
              {/* 参考历史 PPT 状态 */}
              {refPpt && (
                <span className="inline-flex items-center gap-1 rounded-lg border border-primary/30 gradient-brand-soft px-2.5 py-2 text-xs font-medium text-primary">
                  <History className="size-3.5" />
                  参考：{refPpt}
                  <button onClick={() => setRefPpt(null)} aria-label="清除参考" className="hover:text-foreground">
                    <X className="size-3" />
                  </button>
                </span>
              )}
              {/* 保存编辑（真实项目：整份回写 present 步 deck，导出自动用编辑后内容） */}
              {projectId && realDeck && (
                <button
                  onClick={() => void saveDeck()}
                  disabled={deckSaveState === "saving"}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-70 ${
                    deckSaveState === "error"
                      ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                      : "border-primary/40 gradient-brand-soft text-primary hover:opacity-90"
                  }`}
                >
                  {deckSaveState === "saving"
                    ? "保存中…"
                    : deckSaveState === "saved"
                      ? "已保存"
                      : deckSaveState === "error"
                        ? "保存失败，点击重试"
                        : "保存编辑"}
                </button>
              )}
              {/* 导出 */}
              <button
                onClick={onExportEntry}
                disabled={membershipLoading || !projectId || exporting}
                title={!projectId ? "请先从项目进入" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileDown className="size-4" />
                {membershipLoading ? "余额加载中…" : exporting ? "导出中…" : "导出"}
              </button>
            </div>
          )}
        </StepPageHeader>
        {/* 换一份标书述标的入口只留在卡片里（「从我的标书选择 / 上传标书文件」两个按钮）——
            右上角再挂一条是重复的（用户要求去掉）。 */}
        {deckReady && <AiNotice />}

        {/* 导出菜单 */}
        {exportOpen && canAfford && (
          <div className="mt-3 rounded-xl border border-border bg-background p-3">
            <CreditEstimate
              cost={exportCost}
              balance={balance}
              showSupportable={false}
              actionLabel="确认导出"
              onConfirm={() => doExport("pptx")}
            />
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              <button
                onClick={() => doExport("pptx")}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Presentation className="size-4 text-primary" />
                导出 PPTX
              </button>
              <button
                onClick={() => doExport("pdf")}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <FileDown className="size-4 text-destructive" />
                导出 PDF
              </button>
            </div>
          </div>
        )}
        {exportStatus && <p className="mt-2 text-xs font-medium text-primary">{exportStatus}</p>}
        {exportGate && (
          <p className="mt-2 text-xs font-medium text-destructive">
            {exportGate.text}
            <Link href={exportGate.href} className="ml-1.5 font-semibold text-primary underline">
              {exportGate.label}
            </Link>
          </p>
        )}
        {deckSaveState === "error" && <p className="mt-2 text-xs font-medium text-destructive">{deckSaveError || "保存失败，请重试"}</p>}
        {membershipError && <p className="mt-2 text-xs font-medium text-destructive">{membershipError}</p>}
      </div>

      {/* 主体：未生成 → 显式生成入口（明示消耗）；已生成 → 编辑器（前序未完成已在上方独立入口拦截） */}
      {!deckReady ? (
        <EmptyState
          duration={duration}
          onDuration={changeDuration}
          cost={presentCost}
          balance={balance}
          balanceLoading={membershipLoading}
          generating={stepRunning}
          onGenerate={runGenerate}
          styleName={style.name}
          refPpt={refPpt}
          onOpenTemplates={() => setTplOpen(true)}
          existingDeck={hasDeck ? { pages: slides.length, onOpen: () => setDeckView(true) } : undefined}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左栏 · 幻灯片列表 */}
          <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card md:flex">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-xs font-semibold text-foreground">
                幻灯片 · {slides.length} 页
              </span>
              <button
                onClick={addSlide}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
              >
                <Plus className="size-3.5" />
                加页
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-3">
              <ul className="flex flex-col gap-1.5">
                {slides.map((s, i) => (
                  <li
                    key={s.id}
                    draggable
                    onDragStart={() => setDragId(s.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(s.id)}
                  >
                    <button
                      onClick={() => setActiveId(s.id)}
                      className={`group flex w-full items-start gap-2 rounded-lg border p-2 text-left transition-colors ${
                        activeId === s.id
                          ? "border-primary/40 bg-primary/5"
                          : "border-border bg-background hover:border-primary/30"
                      }`}
                    >
                      <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-muted-foreground" />
                      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{s.title}</span>
                      {slides.length > 1 && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteSlide(s.id)
                          }}
                          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                          aria-label="删除本页"
                        >
                          <Trash2 className="size-3.5" />
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-border p-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                预计讲解 {estMin} 分钟
              </span>
            </div>
          </aside>

          {/* 中栏 · 预览与编辑 */}
          <main className="min-w-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6">
            {active && (
              <div className="mx-auto max-w-3xl">
                {/* 幻灯片预览画布 */}
                <SlidePreview slide={active} style={style} />

                {/* 编辑区 */}
                <div className="mt-5 rounded-2xl border border-border bg-card p-5">
                  <label className="text-xs font-medium text-muted-foreground">标题</label>
                  <input
                    value={active.title}
                    onChange={(e) => updateSlide(active.id, { title: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground outline-none focus:border-primary"
                  />

                  <div className="mt-4 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">要点</label>
                    <button
                      onClick={() => addBullet(active.id)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Plus className="size-3.5" />
                      添加要点
                    </button>
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {active.bullets.map((b, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className={`size-1.5 shrink-0 rounded-full ${style.dot}`} />
                        <input
                          value={b}
                          onChange={(e) => updateBullet(active.id, i, e.target.value)}
                          className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                        />
                        <button
                          onClick={() => removeBullet(active.id, i)}
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                          aria-label="删除要点"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* 演讲备注 / 口播稿：随述标生成（80 积分/次）一并交付，不设会员墙——与读标/提纲/正文一致 */}
                  <div className="mt-5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <MessageSquareText className="size-3.5 text-primary" />
                      演讲备注 / 口播稿
                    </label>
                    <textarea
                      value={active.notes}
                      onChange={(e) => updateSlide(active.id, { notes: e.target.value })}
                      rows={4}
                      className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary"
                    />
                  </div>
                </div>

                {/* 预计问答：同随述标生成交付，不设会员墙（真实 deck 无 QA 时整卡不渲染） */}
                {qaList.length > 0 && (
                <div className="mt-5 rounded-2xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2">
                    <HelpCircle className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">评委可能提问 · 建议回答</h3>
                    <span className="ml-auto text-xs text-muted-foreground">{qaList.length} 条</span>
                  </div>
                  <div className="mt-3 flex flex-col gap-2.5">
                    {qaList.map((qa, i) => (
                      <div key={i} className="rounded-xl border border-border bg-background p-3.5">
                        <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                          <span className={`mt-0.5 text-xs font-bold ${style.accent}`}>Q{i + 1}</span>
                          {qa.q}
                        </p>
                        <p className="mt-2 pl-6 text-xs leading-relaxed text-muted-foreground">{qa.a}</p>
                      </div>
                    ))}
                  </div>
                </div>
                )}
              </div>
            )}
          </main>

          {/* 右栏 · AI 协同 */}
          <AiPanel activeTitle={active?.title} onOpenLibrary={() => setLibraryOpen(true)} />
        </div>
      )}

      {/* 资料库选择器（数据由页面级 useLibrary 提供） */}
      {libraryOpen && (
        <LibraryPicker
          title="从资料库插入到本页"
          defaultCat="performance"
          items={libItems}
          loading={libLoading}
          error={libError}
          onClose={() => setLibraryOpen(false)}
          onPick={insertFromLibrary}
        />
      )}

      {/* 模板 / 参考选择器（资料库数据同样由页面级提供） */}
      {tplOpen && (
        <TemplatePicker
          isMember={isMember}
          currentStyleId={style.id}
          refPpt={refPpt}
          libItems={libItems}
          libLoading={libLoading}
          onClose={() => setTplOpen(false)}
          onPickBuiltin={pickBuiltin}
          onPickEnterprise={pickEnterprise}
          onPickReference={pickReference}
          onUploadTemplate={uploadTemplate}
          onUploadReference={uploadReference}
          ensureMember={ensureMember}
        />
      )}
    </div>
  )
}

/** 当前项目还不能述标：保持在这张卡的位置上说清楚差哪一步，并留两个换标书的入口。
 *  不渲染任何计费按钮——后端此时也不放行，亮出来点了就是 409。 */
function NotReadyCard({ projectName, gap }: { projectName: string; gap: { href: string; label: string } }) {
  const cls =
    "inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
  return (
    <div className="flex justify-center p-4">
      <div className="my-auto w-full max-w-xl py-8">
        <div className="rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
            <Presentation className="size-7 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-foreground">一键生成述标大纲</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            述标取的是标书正文（技术标 + 商务标）。当前项目「{projectName}」还没走到这一步，
            先完成「{gap.label}」，回来即可一键生成。
          </p>
          <div className="mt-5 flex justify-center">
            <Link href={gap.href} className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white">
              前往{gap.label}
            </Link>
          </div>
          <p className="mt-5 text-xs text-muted-foreground">或者述标别的标书：</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <a href="/present?view=entry&focus=pick" className={cls}>从我的标书选择</a>
            <a href="/present?view=entry&focus=upload" className={cls}>上传标书文件</a>
          </div>
        </div>
      </div>
    </div>
  )
}

/* 独立述标入口条：挂着项目时也能一键切到「述标其它标书/上传线下标书」（同 risk 页 EntryBar 一致的理由：
   防止用户以为述标只能对当前项目跑）。 */

