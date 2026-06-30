"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Presentation,
  Sparkles,
  Clock,
  Palette,
  FolderOpen,
  Upload,
  Plus,
  Trash2,
  GripVertical,
  Lock,
  MessageSquareText,
  HelpCircle,
  Library,
  Send,
  PanelRightClose,
  PanelRightOpen,
  FileDown,
  Wand2,
  Search,
  X,
  ChevronRight,
  ListChecks,
  Building2,
  History,
  Check,
  Save,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { CreditEstimate } from "@/components/credit-estimate"
import { FlowNav } from "@/components/tool/flow-nav"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { creditCosts, DEMO_CREDIT_BALANCE } from "@/lib/plans"
import {
  buildDeck,
  estimateMinutes,
  presentQA,
  slideStyles,
  enterpriseTemplateStyles,
  type Slide,
  type StyleId,
  type SlideStyle,
} from "@/lib/present"
import { libraryCategories, type LibraryItem, type LibraryCategoryId } from "@/lib/library"

const GEN_COST = creditCosts.find((c) => c.feature === "述标演示生成")?.value ?? 80
const EXPORT_COST = creditCosts.find((c) => c.feature.startsWith("导出"))?.value ?? 20

type Duration = 10 | 15 | 20
const DURATIONS: Duration[] = [10, 15, 20]

export default function PresentPage() {
  const { openPaywall } = usePaywall()
  const router = useRouter()

  /* 演示状态 */
  const [balance, setBalance] = useState(DEMO_CREDIT_BALANCE)
  const [isMember, setIsMember] = useState(false)
  const canAfford = balance >= EXPORT_COST

  /* 配置 */
  const [duration, setDuration] = useState<Duration>(15)
  const [styleId, setStyleId] = useState<StyleId>("blue")
  /* 模板与参考（会员权益） */
  const [tplOpen, setTplOpen] = useState(false)
  const [enterpriseStyle, setEnterpriseStyle] = useState<SlideStyle | null>(null)
  const [refPpt, setRefPpt] = useState<string | null>(null)
  /* 临时上传的企业模板（演示用） */
  const [uploadedTpls, setUploadedTpls] = useState<SlideStyle[]>([])
  /* 已保存到资料库的模板名（演示标记） */
  const [savedTpls, setSavedTpls] = useState<string[]>([])

  /* 大纲生成 */
  const [genState, setGenState] = useState<"idle" | "generating" | "done">("idle")
  const [slides, setSlides] = useState<Slide[]>([])
  const [activeId, setActiveId] = useState<string>("")

  /* 交互 */
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState("")
  const [aiInput, setAiInput] = useState("")
  const [aiReply, setAiReply] = useState("")
  const [dragId, setDragId] = useState<string | null>(null)

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
  /* 套用企业模板 / 参考历史 PPT / 上传：会员专享，免费用户跳会员页 */
  function pickEnterprise(s: SlideStyle) {
    if (!isMember) return router.push("/membership")
    setEnterpriseStyle(s)
    setTplOpen(false)
  }
  function pickReference(name: string) {
    if (!isMember) return router.push("/membership")
    setRefPpt(name)
  }
  function uploadTemplate() {
    if (!isMember) return router.push("/membership")
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
  function uploadReference() {
    if (!isMember) return router.push("/membership")
    setRefPpt(`参考PPT-${uploadedTpls.length + Math.floor(Math.random() * 90 + 10)}.pptx`)
  }
  function saveTemplateToLibrary(name: string) {
    setSavedTpls((arr) => (arr.includes(name) ? arr : [...arr, name]))
  }

  /* ---------------- 生成大纲 ---------------- */
  function runGenerate() {
    setGenState("generating")
    setTimeout(() => {
      const deck = buildDeck(duration)
      setSlides(deck)
      setActiveId(deck[0]?.id ?? "")
      setGenState("done")
    }, 1100)
  }

  /* 切换时长：已生成则按新时长重建 */
  function changeDuration(d: Duration) {
    setDuration(d)
    if (genState === "done") {
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

  /* ---------------- 导出 ---------------- */
  function onExportEntry() {
    if (!canAfford) {
      openPaywall("present")
      return
    }
    setExportOpen((v) => !v)
  }
  function doExport(format: "pptx" | "pdf") {
    const name = format === "pptx" ? "PPTX" : "PDF"
    setExportOpen(false)
    setExportStatus(`正在导出述标 PPT（${name}）…`)
    setTimeout(() => {
      setExportStatus(`已导出述标 PPT（${name}）`)
      setTimeout(() => setExportStatus(""), 2500)
    }, 900)
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* 流程返回区：上一步 + 面包屑 */}
      <div className="shrink-0 px-4 pt-4 sm:px-6">
        <FlowNav current="present" />
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
              {/* 导出 */}
              <button
                onClick={onExportEntry}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                <FileDown className="size-4" />
                导出
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
      </div>

      {/* 主体 */}
      {genState !== "done" ? (
        <EmptyState
          duration={duration}
          onDuration={changeDuration}
          balance={balance}
          generating={genState === "generating"}
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
                    <span className="ml-auto text-xs text-muted-foreground">{presentQA.length} 条</span>
                  </div>
                  <div className="mt-3 flex flex-col gap-2.5">
                    {presentQA.map((qa, i) => (
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

      {/* 演示用切换条 */}
      {genState === "done" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card px-4 py-2 sm:px-6">
          <button
            onClick={() => setBalance((v) => (v >= EXPORT_COST ? Math.max(0, EXPORT_COST - 10) : DEMO_CREDIT_BALANCE))}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="演示用：切换积分余额充足 / 不足"
          >
            余额：{balance} 积分（{canAfford ? "充足" : "不足"}）
          </button>
          <button
            onClick={() => setIsMember((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="演示用：切换免费用户 / 付费会员"
          >
            身份：{isMember ? "付费会员" : "免费用户"}
          </button>
        </div>
      )}

      {/* 资料库选择器 */}
      {libraryOpen && <LibraryPicker onClose={() => setLibraryOpen(false)} onPick={insertFromLibrary} />}

      {/* 模板 / 参考选择器 */}
      {tplOpen && (
        <TemplatePicker
          isMember={isMember}
          currentStyleId={style.id}
          refPpt={refPpt}
          uploadedTpls={uploadedTpls}
          savedTpls={savedTpls}
          onClose={() => setTplOpen(false)}
          onPickBuiltin={pickBuiltin}
          onPickEnterprise={pickEnterprise}
          onPickReference={pickReference}
          onUploadTemplate={uploadTemplate}
          onUploadReference={uploadReference}
          onSaveToLibrary={saveTemplateToLibrary}
        />
      )}
    </div>
  )
}

/* ============== 幻灯片预览画布 ============== */
function SlidePreview({ slide, style }: { slide: Slide; style: (typeof slideStyles)[number] }) {
  if (slide.kind === "cover" || slide.kind === "end") {
    return (
      <div className={`flex aspect-video flex-col items-center justify-center rounded-2xl ${style.coverBg} p-8 text-center text-white shadow-lg`}>
        <Presentation className="size-10 opacity-90" />
        <h2 className="mt-4 text-2xl font-bold text-balance">{slide.title}</h2>
        <div className="mt-4 flex flex-col gap-1 text-sm text-white/85">
          {slide.bullets.map((b, i) => (
            <span key={i}>{b}</span>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="aspect-video overflow-hidden rounded-2xl border border-border bg-card p-7 shadow-lg">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}>
        <ListChecks className="size-3" />
        {slide.scoring}
      </span>
      <div className="mt-3 flex items-center gap-2.5">
        <span className={`h-6 w-1 rounded-full ${style.bar}`} />
        <h2 className="text-xl font-bold text-foreground text-balance">{slide.title}</h2>
      </div>
      <ul className="mt-5 flex flex-col gap-2.5">
        {slide.bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground">
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ============== 付费模糊块 ============== */
function LockedBlock({ text, rows }: { text: string; rows: number }) {
  return (
    <div className="relative mt-1.5">
      <p
        className="select-none overflow-hidden rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground blur-[4px]"
        style={{ maxHeight: `${rows * 1.6}rem` }}
        aria-hidden
      >
        {text}
      </p>
      <div className="absolute inset-0 flex items-center justify-center">
        <Link
          href="/membership"
          className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Lock className="size-3.5" />
          解锁完整演讲稿与问答
        </Link>
      </div>
    </div>
  )
}

/* ============== 空状态：生成大纲 ============== */
function EmptyState({
  duration,
  onDuration,
  balance,
  generating,
  onGenerate,
  styleName,
  refPpt,
  onOpenTemplates,
}: {
  duration: Duration
  onDuration: (d: Duration) => void
  balance: number
  generating: boolean
  onGenerate: () => void
  styleName: string
  refPpt: string | null
  onOpenTemplates: () => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-xl py-8">
        <div className="rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
            <Presentation className="size-7 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-foreground">一键生成述标大纲</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            默认取当前项目已生成的标书内容（技术标 + 商务标），按评分点提炼为封面、项目理解、技术亮点、团队、业绩、服务承诺、报价、风险防控等演示页。
          </p>

          {/* 时长选择 */}
          <div className="mt-5">
            <p className="text-xs font-medium text-muted-foreground">选择述标时长</p>
            <div className="mt-2 inline-flex items-center gap-1 rounded-xl border border-border bg-background p-1">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => onDuration(d)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    duration === d ? "gradient-brand text-white" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d} 分钟
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">AI 将据此调整页数与每页内容密度</p>
          </div>

          {/* 模板与参考 */}
          <div className="mt-5">
            <p className="text-xs font-medium text-muted-foreground">演示模板与参考</p>
            <button
              onClick={onOpenTemplates}
              className="mx-auto mt-2 inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
            >
              <Palette className="size-4 text-primary" />
              模板：{styleName}
              {refPpt && <span className="text-xs text-muted-foreground">· 参考 {refPpt}</span>}
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              可套用企业自有模板或参考历史述标 PPT（会员专享）
            </p>
          </div>

          {/* 数据来源 */}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary">
              <FolderOpen className="size-4" />
              从我的标书选择
            </button>
            <button className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary">
              <Upload className="size-4" />
              上传标书文件
            </button>
          </div>

          {/* 积分预估 + 生成 */}
          <div className="mt-6">
            {generating ? (
              <div className="inline-flex items-center gap-2 rounded-xl gradient-brand px-6 py-3 text-sm font-semibold text-white">
                <Sparkles className="size-4 animate-pulse" />
                正在生成述标大纲…
              </div>
            ) : (
              <CreditEstimate
                cost={GEN_COST}
                balance={balance}
                unitLabel="次"
                showSupportable={false}
                actionLabel="生成述标大纲"
                onConfirm={onGenerate}
              />
            )}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">生成与预览免费查看；演讲稿、问答与导出消耗积分，余额不足时再充值或开通会员</p>
        </div>
      </div>
    </div>
  )
}

/* ============== 资料库选择器（复用资料库数据） ============== */
function LibraryPicker({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (item: LibraryItem) => void
}) {
  const [cat, setCat] = useState<LibraryCategoryId>("performance")
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
            <h2 className="text-base font-semibold text-foreground">从资料库插入到本页</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

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
                  {it.fields?.length ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {it.fields.map((f) => `${f.label}：${f.value}`).join(" · ")}
                    </p>
                  ) : null}
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  插入
                  <ChevronRight className="size-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============== 模板 / 参考选择器 ============== */
function TemplatePicker({
  isMember,
  currentStyleId,
  refPpt,
  uploadedTpls,
  savedTpls,
  onClose,
  onPickBuiltin,
  onPickEnterprise,
  onPickReference,
  onUploadTemplate,
  onUploadReference,
  onSaveToLibrary,
}: {
  isMember: boolean
  currentStyleId: string
  refPpt: string | null
  uploadedTpls: SlideStyle[]
  savedTpls: string[]
  onClose: () => void
  onPickBuiltin: (id: StyleId) => void
  onPickEnterprise: (s: SlideStyle) => void
  onPickReference: (name: string) => void
  onUploadTemplate: () => void
  onUploadReference: () => void
  onSaveToLibrary: (name: string) => void
}) {
  useEscapeClose(onClose)
  const presCat = libraryCategories.find((c) => c.id === "presentation")
  const enterpriseItems = presCat?.items.filter((it) => it.tags?.includes("企业模板")) ?? []
  const historyItems = presCat?.items.filter((it) => it.tags?.includes("历史述标")) ?? []

  /* 会员专享角标 */
  const MemberBadge = () => (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      <Lock className="size-3" />
      会员专享
    </span>
  )

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Palette className="size-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">演示模板与参考</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* 内置预设 */}
          <p className="text-xs font-semibold text-foreground">内置预设</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {slideStyles.map((s) => {
              const selected = currentStyleId === s.id
              return (
                <button
                  key={s.id}
                  onClick={() => onPickBuiltin(s.id as StyleId)}
                  className={`flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors ${
                    selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background hover:border-primary/30"
                  }`}
                >
                  <span className={`h-8 w-full rounded-md ${s.coverBg}`} />
                  <span className="flex w-full items-center justify-between text-xs font-medium text-foreground">
                    {s.name}
                    {selected && <Check className="size-3.5 text-primary" />}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 企业模板 */}
          <div className="mt-5 flex items-center gap-2">
            <Building2 className="size-4 text-primary" />
            <p className="text-xs font-semibold text-foreground">企业自有模板</p>
            {!isMember && <MemberBadge />}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[...enterpriseItems.map((it) => ({
              key: it.id,
              name: it.title,
              meta: it.meta,
              style: enterpriseTemplateStyles[it.id],
            })),
            ...uploadedTpls.map((s) => ({ key: s.id, name: s.name, meta: "本次上传", style: s }))].map((tpl) => {
              const palette = tpl.style ?? enterpriseTemplateStyles.pe1
              const selected = currentStyleId === palette.id
              const isUploaded = tpl.meta === "本次上传"
              return (
                <div
                  key={tpl.key}
                  className={`flex flex-col gap-2 rounded-xl border p-3 transition-colors ${
                    selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background"
                  }`}
                >
                  <button onClick={() => onPickEnterprise(palette)} className="flex items-start gap-3 text-left">
                    <span className={`h-10 w-14 shrink-0 rounded-md ${palette.coverBg}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <span className="truncate">{tpl.name}</span>
                        {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                        {!isMember && <Lock className="size-3 shrink-0 text-primary" />}
                      </span>
                      {tpl.meta && <span className="mt-0.5 block text-[11px] text-muted-foreground">{tpl.meta}</span>}
                      <span className="mt-1 block text-[11px] text-primary">套用此模板版式</span>
                    </span>
                  </button>
                  {isUploaded && (
                    <button
                      onClick={() => onSaveToLibrary(tpl.name)}
                      disabled={savedTpls.includes(tpl.name)}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      {savedTpls.includes(tpl.name) ? <Check className="size-3 text-success" /> : <Save className="size-3" />}
                      {savedTpls.includes(tpl.name) ? "已存入资料库" : "保存到资料库"}
                    </button>
                  )}
                </div>
              )
            })}
            {/* 上传企业模板 */}
            <button
              onClick={onUploadTemplate}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Upload className="size-4" />
              上传企业模板（.pptx / .potx）
              {!isMember && <Lock className="size-3 text-primary" />}
            </button>
          </div>

          {/* 参考历史 PPT */}
          <div className="mt-5 flex items-center gap-2">
            <History className="size-4 text-primary" />
            <p className="text-xs font-semibold text-foreground">参考历史述标 PPT</p>
            {!isMember && <MemberBadge />}
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {historyItems.map((it) => {
              const selected = refPpt === it.title
              return (
                <button
                  key={it.id}
                  onClick={() => onPickReference(it.title)}
                  className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${
                    selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background hover:border-primary/30"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="truncate">{it.title}</span>
                      {!isMember && <Lock className="size-3 shrink-0 text-primary" />}
                    </span>
                    {it.meta && <span className="mt-0.5 block text-[11px] text-muted-foreground">{it.meta}</span>}
                  </span>
                  {selected ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            })}
            <button
              onClick={onUploadReference}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Upload className="size-4" />
              上传参考 PPT（.pptx / .ppt）
              {!isMember && <Lock className="size-3 text-primary" />}
            </button>
          </div>
        </div>

        <div className="border-t border-border bg-muted/40 px-5 py-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            套用企业模板版式 + 参考要点结构，<span className="font-medium text-foreground">不承诺一键复刻原 PPT 设计</span>。
            企业模板、历史述标参考与上传模板为
            <Link href="/membership" className="mx-0.5 font-medium text-primary hover:underline">
              付费会员
            </Link>
            权益。
          </p>
        </div>
      </div>
    </div>
  )
}
