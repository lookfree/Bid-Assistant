"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Presentation,
  Sparkles,
  Clock,
  Palette,
  Plus,
  Trash2,
  GripVertical,
  MessageSquareText,
  HelpCircle,
  Library,
  Send,
  PanelRightClose,
  PanelRightOpen,
  FileDown,
  Wand2,
  X,
  ChevronRight,
  History,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { CreditEstimate } from "@/components/credit-estimate"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepBanner } from "@/components/tool/step-banner"
import { LibraryPicker } from "@/components/tool/library-picker"
import { creditCosts } from "@/lib/plans"
import { useMembership } from "@/lib/use-membership"
import { useLibrary } from "@/lib/use-library"
import { createEntry } from "@/lib/library-api"
import { uploadFile } from "@/lib/files"
import {
  buildDeck,
  estimateMinutes,
  presentQA,
  slideStyles,
  type Slide,
  type StyleId,
  type SlideStyle,
} from "@/lib/present"
import { type LibraryItem } from "@/lib/library"
import { ApiError } from "@/lib/api-client"
import { useStep } from "@/lib/use-step"
import { artifactUrl, patchStep, runStep } from "@/lib/project"
import { EmptyState, DURATIONS, type Duration } from "./empty-state"
import { TemplatePicker } from "./template-picker"
import { LockedBlock, SlidePreview } from "./slide-preview"

// agent DeckSpec（camelCase）：slides/qa 与原型 Slide/QA 同构
type RealDeck = { title: string; duration: number; template: string; slides: Slide[]; qa: { q: string; a: string }[] }

const EXPORT_COST = creditCosts.find((c) => c.feature.startsWith("导出"))?.value ?? 20

export default function PresentPage() {
  const { openPaywall } = usePaywall()
  const router = useRouter()

  /* 真实积分余额与会员身份（GET /api/membership；仅 active 订阅算会员权益） */
  const { balance, isMember, loading: membershipLoading, error: membershipError } = useMembership()
  const canAfford = balance >= EXPORT_COST
  /* 资料库数据提升到页面级：LibraryPicker / TemplatePicker 共用同一份，避免同页重复拉取 */
  const { items: libItems, loading: libLoading, error: libError, reload: reloadLibrary } = useLibrary()

  /* 配置 */
  const [duration, setDuration] = useState<Duration>(15)
  const [styleId, setStyleId] = useState<StyleId>("blue")
  /* 模板与参考（会员权益） */
  const [tplOpen, setTplOpen] = useState(false)
  const [enterpriseStyle, setEnterpriseStyle] = useState<SlideStyle | null>(null)
  const [refPpt, setRefPpt] = useState<string | null>(null)
  /* 临时上传的企业模板（演示用） */
  const [uploadedTpls, setUploadedTpls] = useState<SlideStyle[]>([])

  /* 大纲生成 */
  const [genState, setGenState] = useState<"idle" | "generating" | "done">("idle")
  const [slides, setSlides] = useState<Slide[]>([])
  const [activeId, setActiveId] = useState<string>("")

  /* 交互 */
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState("")
  /* 402 积分不足等需要引导入口的导出错误：文案 + 链接（不随 3 秒自动消失） */
  const [exportGate, setExportGate] = useState<{ text: string; href: string; label: string } | null>(null)
  const [aiInput, setAiInput] = useState("")
  const [aiReply, setAiReply] = useState("")
  const [dragId, setDragId] = useState<string | null>(null)

  /* 真实项目：present 步产 DeckSpec（真实幻灯+口播稿），到位即覆盖示例。
     生成调用透传当前时长/模板（POST steps/present body {duration, template}）。 */
  const { projectId, info, data: realDeck, running: stepRunning, error: stepError, errorStatus: stepErrorStatus, start } = useStep<RealDeck>("present")
  // 自动触发只此一次（失败后改选时长/模板不静默重跑，重试走横幅按钮或生成按钮，避免误扣积分）
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current) return
    if (projectId && info && !realDeck && !stepRunning && info.project.currentStep === "present") {
      autoStarted.current = true
      void start({ duration, template: styleId })
    }
  }, [projectId, info, realDeck, stepRunning, start, duration, styleId])
  useEffect(() => {
    if (!realDeck) return
    setSlides(realDeck.slides)
    setActiveId(realDeck.slides[0]?.id ?? "")
    // 选择器与后端已存 deck 对齐（保存/下次生成据此透传）
    if (DURATIONS.includes(realDeck.duration as Duration)) setDuration(realDeck.duration as Duration)
    if (slideStyles.some((s) => s.id === realDeck.template)) setStyleId(realDeck.template as StyleId)
    setGenState("done")
  }, [realDeck])

  /* 当前预览样式：套用企业模板时优先，否则用内置预设 */
  const style = enterpriseStyle ?? slideStyles.find((s) => s.id === styleId)!
  const active = slides.find((s) => s.id === activeId)
  const estMin = useMemo(() => estimateMinutes(slides), [slides])

  /* 选内置预设：清除企业模板套用 */
  function pickBuiltin(id: StyleId) {
    setStyleId(id)
    setEnterpriseStyle(null)
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
  /* 套用企业模板 / 参考历史 PPT / 上传：会员专享，免费用户跳会员页 */
  function pickEnterprise(s: SlideStyle) {
    if (!ensureMember()) return
    setEnterpriseStyle(s)
    setTplOpen(false)
  }
  function pickReference(name: string) {
    if (!ensureMember()) return
    setRefPpt(name)
  }
  function uploadTemplate() {
    if (!ensureMember()) return
    const n = uploadedTpls.length + 1
    const s: SlideStyle = {
      id: `upload-${Date.now()}`,
      name: `已上传模板 ${n}.pptx`,
      swatch: "bg-emerald-600",
      coverBg: "bg-emerald-700",
      bar: "bg-emerald-600",
      dot: "bg-emerald-600",
      chip: "bg-emerald-600/10 text-emerald-700",
      accent: "text-emerald-700",
    }
    setUploadedTpls((arr) => [...arr, s])
    setEnterpriseStyle(s)
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
  /* 把本次上传的企业模板存入资料库（真实 POST /api/library）。
     企业模板/历史述标目前按 tags 契约判定（spec315 考虑改为子分类字段）。 */
  async function saveTemplateToLibrary(name: string) {
    await createEntry({ category: "presentation", tags: ["企业模板"], title: name })
    // 入库成功：从「本次上传」临时列表移除，改由资料库数据渲染，避免同名重复展示
    setUploadedTpls((arr) => arr.filter((s) => s.name !== name))
    await reloadLibrary()
  }

  /* ---------------- 生成大纲 ---------------- */
  function runGenerate() {
    // 真实项目：跑 present 步并透传当前时长/模板；无项目（demo）回落示例 deck
    if (projectId) {
      void start({ duration, template: styleId })
      return
    }
    setGenState("generating")
    setTimeout(() => {
      const deck = buildDeck(duration)
      setSlides(deck)
      setActiveId(deck[0]?.id ?? "")
      setGenState("done")
    }, 1100)
  }

  /* 切换时长：demo 已生成则按新时长重建示例；真实项目只更新选择器
     （新时长随下次生成透传，或经「保存」回写 deck.duration，避免误触重复扣积分） */
  function changeDuration(d: Duration) {
    setDuration(d)
    if (!projectId && genState === "done") {
      const deck = buildDeck(d)
      setSlides(deck)
      setActiveId(deck[0]?.id ?? "")
    }
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

  /* ---------------- AI 协同 ---------------- */
  function runAi(cmd: string) {
    if (!active) return
    setAiReply(`已根据「${cmd}」优化本页要点与演讲备注，可在中栏查看并继续微调。`)
    setAiInput("")
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
    } catch {
      setDeckSaveState("error")
    }
  }

  /* 预计问答：真实 deck 用生成的 QA，否则示例 */
  const qaList = realDeck?.qa?.length ? realDeck.qa : presentQA

  /* ---------------- 导出 ---------------- */
  function onExportEntry() {
    // 余额加载中不做付费墙判定（按钮已禁用，双保险防按 balance=0 误弹）
    if (membershipLoading) return
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
    setExportStatus("正在获取下载链接…")
    void (async () => {
      try {
        let url: string
        try {
          url = await artifactUrl(projectId, "pptx")
        } catch {
          // pptx key 随 export 步的 artifacts 快照可见：未跑过 export 就先跑（确定性、低成本）
          setExportStatus("正在整理产物…")
          await runStep(projectId, "export")
          url = await artifactUrl(projectId, "pptx")
        }
        window.open(url, "_blank")
        setExportStatus("已导出，浏览器开始下载")
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
        setTimeout(() => setExportStatus(""), 3000)
      }
    })()
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* 流程返回区：上一步 + 面包屑 */}
      <div className="shrink-0 px-4 pt-4 sm:px-6">
        <FlowNav current="present" />
      {
        <StepBanner
          running={stepRunning}
          error={stepError}
          runningText="AI 正在基于标书与评分点生成述标稿与 PPT…"
          onRetry={() => void start({ duration, template: styleId })}
          action={stepErrorStatus === 402 ? { href: "/membership", label: "去充值" } : undefined}
        />
      }
      </div>
      {/* 顶部工具条 */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl gradient-brand">
              <Presentation className="size-5 text-white" />
            </span>
            <div>
              <h1 className="text-base font-bold tracking-tight text-foreground">述标演示</h1>
              <p className="text-xs text-muted-foreground">一键把标书提炼成述标/答辩 PPT，含演讲备注与预计问答</p>
            </div>
          </div>

          {genState === "done" && (
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
                disabled={membershipLoading || !projectId}
                title={!projectId ? "请先从项目进入" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileDown className="size-4" />
                {membershipLoading ? "余额加载中…" : "导出"}
              </button>
            </div>
          )}
        </div>

        {/* 导出菜单 */}
        {exportOpen && canAfford && (
          <div className="mt-3 rounded-xl border border-border bg-background p-3">
            <CreditEstimate
              cost={EXPORT_COST}
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
        {membershipError && <p className="mt-2 text-xs font-medium text-destructive">{membershipError}</p>}
      </div>

      {/* 主体 */}
      {genState !== "done" ? (
        <EmptyState
          duration={duration}
          onDuration={changeDuration}
          balance={balance}
          balanceLoading={membershipLoading}
          generating={genState === "generating" || stepRunning}
          onGenerate={runGenerate}
          styleName={style.name}
          refPpt={refPpt}
          onOpenTemplates={() => setTplOpen(true)}
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

                  {/* 演讲备注 / 口播稿 —— 付费钩子 */}
                  <div className="mt-5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <MessageSquareText className="size-3.5 text-primary" />
                      演讲备注 / 口播稿
                    </label>
                    {isMember ? (
                      <textarea
                        value={active.notes}
                        onChange={(e) => updateSlide(active.id, { notes: e.target.value })}
                        rows={4}
                        className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary"
                      />
                    ) : (
                      <LockedBlock text={active.notes} rows={4} />
                    )}
                  </div>
                </div>

                {/* 预计问答 —— 付费钩子 */}
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
                        {isMember ? (
                          <p className="mt-2 pl-6 text-xs leading-relaxed text-muted-foreground">{qa.a}</p>
                        ) : (
                          <div className="mt-2 pl-6">
                            <LockedBlock text={qa.a} rows={2} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </main>

          {/* 右栏 · AI 协同 */}
          {aiCollapsed ? (
            <button
              onClick={() => setAiCollapsed(false)}
              className="hidden w-12 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-4 text-muted-foreground transition-colors hover:text-foreground lg:flex"
              aria-label="展开 AI 协同"
            >
              <PanelRightOpen className="size-5" />
              <span className="text-xs [writing-mode:vertical-rl]">AI 协同</span>
            </button>
          ) : (
            <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-card lg:flex">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Sparkles className="size-4 text-primary" />
                  AI 协同
                </span>
                <button
                  onClick={() => setAiCollapsed(true)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="折叠"
                >
                  <PanelRightClose className="size-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                <p className="text-xs text-muted-foreground">针对当前页「{active?.title}」改写优化：</p>
                <div className="mt-3 flex flex-col gap-2">
                  {["更口语", "更突出亮点", "压缩到 1 分钟讲完", "补充数据支撑"].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => runAi(cmd)}
                      className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <Wand2 className="size-3.5 text-primary" />
                      {cmd}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setLibraryOpen(true)}
                  className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 gradient-brand-soft px-3 py-2 text-xs font-semibold text-primary transition-opacity hover:opacity-90"
                >
                  <Library className="size-3.5" />
                  从资料库插入
                </button>

                {aiReply && (
                  <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-foreground">
                    {aiReply}
                  </div>
                )}
              </div>

              <div className="border-t border-border p-3">
                <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
                  <input
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && aiInput.trim()) runAi(aiInput.trim())
                    }}
                    placeholder="描述你想怎么改这一页…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                  <button
                    onClick={() => aiInput.trim() && runAi(aiInput.trim())}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg gradient-brand text-white transition-opacity hover:opacity-90"
                    aria-label="发送"
                  >
                    <Send className="size-3.5" />
                  </button>
                </div>
              </div>
            </aside>
          )}
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
          uploadedTpls={uploadedTpls}
          libItems={libItems}
          libLoading={libLoading}
          onClose={() => setTplOpen(false)}
          onPickBuiltin={pickBuiltin}
          onPickEnterprise={pickEnterprise}
          onPickReference={pickReference}
          onUploadTemplate={uploadTemplate}
          onUploadReference={uploadReference}
          onSaveToLibrary={saveTemplateToLibrary}
          ensureMember={ensureMember}
        />
      )}
    </div>
  )
}

