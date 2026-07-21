"use client"
import { ApiError } from "@/lib/api-client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  FileText,
  Target,
  AlertTriangle,
  CheckCircle2,
  Upload,
  ArrowRight,
  FileCheck2,
  MapPin,
  Loader2,
  Star,
  ShieldCheck,
  Wallet,
  Cpu,
  ClipboardList,
  Layers,
  Boxes,
  Check,
  type LucideIcon,
} from "lucide-react"
import type { AnalysisItem, PackageInfo, ScoringRow, StructureItem, StructureKind } from "@/lib/bid-types"
import { useStep } from "@/lib/use-step"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { clauseLocationIn, groupDocSections, type DocSentence } from "@/lib/doc-sections"
import { cloneProject, setProjectPackage } from "@/lib/project"

// 分类解读类目 icon（agent 结果只带 key，不产 UI 组件），未知 key 兜底 FileText
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  overview: FileText,
  qualification: ShieldCheck,
  commercial: Wallet,
  technical: Cpu,
  scoring: Target,
  format: ClipboardList,
}

// 投标文件构成清单（spec321）：kind 徽标样式，沿用页面已有 badge 配色（primary/accent/success/warning）
const STRUCTURE_KIND_LABEL: Record<StructureKind, string> = {
  volume: "分册",
  chapter: "章节",
  form: "表单",
  rule: "程序要求",
}
const STRUCTURE_KIND_BADGE: Record<StructureKind, string> = {
  volume: "bg-primary/10 text-primary",
  chapter: "bg-accent text-accent-foreground",
  form: "bg-success/10 text-success",
  rule: "bg-warning/15 text-warning-foreground",
}

// agent ReadResult（App 已转 camelCase）→ 原型渲染形状；icon 按 key 从示例类目合并（agent 不产 UI 组件）。
// docSections = 招标原文分句（spec315a），有真实结果时左栏渲染真实原文。
type RealRead = {
  categories: { key: string; title: string; items: AnalysisItem[] }[]
  scoring?: ScoringRow[]
  riskSummary?: string[]
  docSections?: DocSentence[]
  /** 投标文件构成清单（spec321），旧项目读标结果无该字段 */
  requiredStructure?: StructureItem[]
  /** 包件划分（spec324），单包标书为空/缺省 */
  packages?: PackageInfo[]
}
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { StepBanner } from "@/components/tool/step-banner"
import { TenderDocPanel } from "@/components/tool/tender-doc-panel"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"
import { AiNotice } from "@/components/tool/ai-notice"


export default function ReadPage() {
  const { projectId, info, data: real, dataLoading, running, phase, error, errorAction, start } = useStep<RealRead>("read")
  const { overview } = useMembership()
  const readCost = creditCostValue(overview, "read", 20)
  // 唯一允许的自动触发：从上传页「开始智能读标」跳转（URL 带 ?autostart=1，那一下点击即计费授权，
  // 费用已在上传按钮标注）。one-shot ref 保证只跑一次；其余场景一律走页面主按钮显式点击。
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || !projectId || !info || real || running) return
    if (typeof window === "undefined") return
    if (new URLSearchParams(window.location.search).get("autostart") !== "1") return
    if (info.project.currentStep !== "read") return
    autoStarted.current = true
    // 授权即消费：立刻把 autostart 从地址栏摘掉。ref 只活在本次挂载——刷新/登录态恢复导致
    // 重挂载时 ref 归零,若参数还留在 URL,一次点击授权会被重放成再次自动扣费跑读标(生产实测)。
    window.history.replaceState(null, "", window.location.pathname)
    void start()
  }, [projectId, info, real, running, start])
  // 数据一律来自真实 read 步结果；该步未跑时页面停在显式生成入口，绝不渲染示例。
  // 单轮读标（小标书）直接用模型原始 categories，模型可能对同一 key 产出多个块（如把资格拆成两段）；
  // 右栏按 key 过滤渲染，重复 key 会让一次点击把多类内容全堆出来（实测「点几次就对不上号/展示全部」）。
  // 此处按 key 合并去重：items 顺序拼接、保留首个 title/icon，保证每类唯一（tab 也不再重复）。
  const categories = useMemo(() => {
    if (!real) return []
    const byKey = new Map<string, { key: string; title: string; icon: LucideIcon; items: AnalysisItem[] }>()
    for (const c of real.categories) {
      const items = c.items.map((i) => ({ ...i, clauseIds: i.clauseIds ?? [] }))
      const prev = byKey.get(c.key)
      if (prev) prev.items.push(...items)
      else byKey.set(c.key, { key: c.key, title: c.title, icon: CATEGORY_ICONS[c.key] ?? FileText, items })
    }
    return [...byKey.values()]
  }, [real])
  const scoringTable = real?.scoring ?? []
  const requiredStructure = real?.requiredStructure ?? []
  const packages = real?.packages ?? []

  // 已选包件（spec324）：初值取项目详情的 selectedPackage，用户可随时重选。
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null)
  useEffect(() => {
    setSelectedPackageId(info?.project.selectedPackage?.id ?? null)
  }, [info])
  const [pkgState, setPkgState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [pkgMessage, setPkgMessage] = useState("")
  async function selectPackage(pkg: PackageInfo) {
    if (!projectId || pkgState === "saving") return
    setPkgState("saving")
    try {
      await setProjectPackage(projectId, { id: pkg.id, name: pkg.name })
      setSelectedPackageId(pkg.id)
      setPkgMessage(`已选择包件：${pkg.name}（提纲及后续步骤将只覆盖该包件）`)
      setPkgState("saved")
      setTimeout(() => setPkgState((s) => (s === "saved" ? "idle" : s)), 3000)
    } catch (e) {
      // 409 package_locked：提纲已开跑，包件锁死——引导去克隆项目投另一个包，而非泛化重试。
      // 409 package_taken：该包已在兄弟项目生成过大纲（一包一份投标文件）——换个包选。
      if (e instanceof ApiError && e.status === 409) {
        setPkgMessage(e.code === "package_taken"
          ? "该包件已在其它项目生成过大纲，请选择其它包件"
          : "提纲已生成，包件已锁定。要投其它包件，请用下方「再建一个项目」。")
        setPkgState("error")
      } else {
        setPkgMessage("选择包件失败，请重试")
        setPkgState("error")
      }
    }
  }

  // 兼投多包件：另建项目（同一招标文件，read 步重新跑）。建项即选包——新项目带着所投的包创建，
  // 名称同时带包名；只有还没生成过大纲的包可选（已生成的包不重复投）。
  const [cloneState, setCloneState] = useState<"idle" | "cloning" | "error">("idle")
  async function handleClone(pkg: PackageInfo) {
    if (!projectId || cloneState === "cloning") return
    setCloneState("cloning")
    try {
      await cloneProject(projectId, { id: pkg.id, name: pkg.name })
      // 目标仍是 /read（当前路由）：router.push 到相同路径不会重新挂载组件，
      // useStep 的 projectId 初始 state 不会重读 localStorage；改整页跳转确保新项目 id 生效。
      window.location.href = "/read"
    } catch {
      setCloneState("error")
    }
  }
  // 可再投的包 = 全部包 − 兄弟项目已生成的包 − 本项目已生成的包（提纲已开跑即锁定占用）
  const outlineStarted = !!info?.steps.some((s) => s.step === "outline")
  const takenPackageIds = info?.takenPackageIds ?? []
  const cloneCandidates = packages.filter(
    (pkg) => !takenPackageIds.includes(pkg.id) && !(outlineStarted && pkg.id === selectedPackageId),
  )
  // 左栏原文：read 结果带分句时按 id 前缀分组渲染真实原文
  const docSections = useMemo(
    () => (real?.docSections?.length ? groupDocSections(real.docSections) : []),
    [real],
  )
  const locate = (clauseIds?: string[]) => clauseLocationIn(docSections, clauseIds)
  // 头部文件名：项目名（GET /api/projects/:id 的 name，缺省兜底）
  const docFileName = info?.project.name ?? "我的项目"

  const clauseRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  /* 精确高亮的条款 id（可多条）+ 弱上下文高亮的所属章节 */
  const [activeClauses, setActiveClauses] = useState<string[]>([])
  const [activeSection, setActiveSection] = useState<string>(docSections[0]?.id ?? "")
  const [activeItem, setActiveItem] = useState<string>("")
  const [activeCategory, setActiveCategory] = useState<string>(categories[0]?.key ?? "")
  const [reportState, setReportState] = useState<"idle" | "generating" | "ready">("idle")
  // 真实结果异步到达后，把类目选中态对齐到第一个真实类目
  useEffect(() => {
    if (categories.length && !categories.some((c) => c.key === activeCategory)) {
      setActiveCategory(categories[0].key)
    }
  }, [categories, activeCategory])

  const allItems = categories.flatMap((c) => c.items)
  const foundCount = allItems.filter((i) => i.status === "found").length
  const missingCount = allItems.filter((i) => i.status === "missing").length

  function handleItemClick(clauseIds: string[] | undefined, key: string) {
    if (!clauseIds || clauseIds.length === 0) return
    setActiveClauses(clauseIds)
    setActiveItem(key)
    setActiveSection(clauseIds[0].replace(/-c\d+$/, ""))
    clauseRefs.current[clauseIds[0]]?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  function generateReport() {
    setReportState("generating")
    setTimeout(() => setReportState("ready"), 1600)
  }

  // 无进行中项目：只引导上传，不渲染任何示例内容
  if (!projectId)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="read" info={info} />
        <NoProjectGuide />
      </div>
    )

  // 项目数据加载中（大标书读标结果可达 1MB，拉取要数秒）：先显示加载态——
  // 绝不能在数据未就绪时把「开始智能读标」计费按钮裸露出来（用户会当成"还没读过"误触发重跑）。
  if (!info || dataLoading)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="read" info={info} />
        <StepPlaceholder text={dataLoading ? "正在加载读标数据…" : "正在加载项目…"} delayMs={250} />
      </div>
    )

  // 该步未跑：停在显式生成入口（消耗数标注在按钮上），运行中/失败由横幅呈现
  if (!real)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="read" info={info} />
        <StepBanner
          running={running}
          error={error}
          runningText={phase ? `AI 读标中：${phase.label}…` : "AI 正在通读招标文件，提取评分点与废标红线…（约 1–2 分钟）"}
          onRetry={() => void start()}
          action={errorAction ?? undefined}
        />
        {running || error ? (
          <StepPlaceholder text={error ? "结果加载异常，请按上方提示重试或刷新" : "读标完成后显示招标原文与分类解读"} />
        ) : (
          <StepRunCta
            title="开始智能读标"
            desc="AI 通读招标文件，自动提取评分点、资格要求与废标红线，完成后可逐条定位原文"
            costText={`消耗 ${readCost} 积分`}
            actionLabel="开始智能读标"
            onRun={() => void start()}
          />
        )}
      </div>
    )

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <FlowNav current="read" info={info} />
      <StepPageHeader icon={FileText} title="招标解读" desc="AI 通读招标文件，自动提取评分点、资格要求与废标红线，点击逐条定位原文">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <CheckCircle2 className="size-3.5" />
              已识别 {foundCount}
            </span>
            <span className="h-3 w-px bg-border" />
            <span className="inline-flex items-center gap-1 font-medium text-warning">
              <AlertTriangle className="size-3.5" />
              待补充 {missingCount}
            </span>
          </div>
          <button
            onClick={generateReport}
            disabled={reportState === "generating"}
            className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-70"
          >
            {reportState === "generating" ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                正在生成…
              </>
            ) : (
              <>
                <FileCheck2 className="size-4" />
                生成标书分析报告
              </>
            )}
          </button>
        </div>
      
      </StepPageHeader>
      <AiNotice />

      {reportState === "ready" && (
        <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-success/30 bg-success/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            <div>
              <p className="text-sm font-semibold text-foreground">标书分析报告已生成</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                已覆盖 {foundCount} 项关键要求，{missingCount} 项招标文件中未明确，可在编标时重点关注
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
              <Upload className="size-4 rotate-180" />
              下载报告
            </button>
            <Link
              href="/outline"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              生成提纲
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      )}

      {/* 多包件招标选包（spec324）：≤1 包不渲染，行为与今天一致 */}
      {packages.length > 1 && (
        <PackageSelector
          packages={packages}
          takenIds={takenPackageIds}
          cloneCandidates={cloneCandidates}
          selectedId={selectedPackageId}
          saving={pkgState === "saving"}
          message={pkgState === "saved" ? pkgMessage : null}
          error={pkgState === "error" ? (pkgMessage || "选择包件失败，请重试") : null}
          onSelect={(pkg) => void selectPackage(pkg)}
          onClone={(pkg) => void handleClone(pkg)}
          cloning={cloneState === "cloning"}
          cloneError={cloneState === "error" ? "创建新项目失败，请重试" : null}
        />
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* 左侧：原始文档（真实分句 / 示例回落） */}
        <TenderDocPanel
          fileName={docFileName}
          sections={docSections}
          activeSection={activeSection}
          activeClauses={activeClauses}
          registerClauseRef={(id, el) => {
            clauseRefs.current[id] = el
          }}
        />

        {/* 右侧：分类分析 */}
        <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
          <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <Target className="size-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold text-foreground">分类解读</span>
            <span className="ml-auto text-xs text-muted-foreground">点击类目查看内容</span>
          </header>

          {/* 类目标签栏 */}
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
            {categories.map((cat) => {
              const isActive = activeCategory === cat.key
              const missing = cat.items.filter((it) => it.status === "missing").length
              return (
                <button
                  key={cat.key}
                  onClick={() => setActiveCategory(cat.key)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "gradient-brand text-white"
                      : "border border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <cat.icon className="size-4" />
                  {cat.title}
                  {missing > 0 && (
                    <span
                      className={`flex size-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                        isActive ? "bg-white/25 text-white" : "bg-warning/20 text-warning-foreground"
                      }`}
                    >
                      {missing}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
            {/* 真实项目读标未完成：占位，不回落示例解读 */}
            {categories.length === 0 && <StepPlaceholder text="读标完成后显示评分点与分类解读" />}
            <div className="flex flex-col gap-5">
              {categories
                .filter((cat) => cat.key === activeCategory)
                .map((cat) => (
                <div key={cat.key}>
                  <div className="flex items-center gap-2 px-1">
                    <cat.icon className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">{cat.title}</h3>
                    <span className="ml-auto text-xs text-muted-foreground">{cat.items.length} 项</span>
                  </div>

                  {cat.key === "scoring" && scoringTable.length === 0 && (
                    <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                      读标完成后显示评分表
                    </p>
                  )}
                  {cat.key === "scoring" && scoringTable.length > 0 && (
                    <div className="mt-3 overflow-hidden rounded-xl border border-border">
                      <table className="w-full border-collapse text-left text-[13px]">
                        <thead>
                          <tr className="bg-muted/60 text-xs text-muted-foreground">
                            <th className="px-3 py-2 font-medium">评分项</th>
                            <th className="px-3 py-2 font-medium">分值</th>
                            <th className="px-3 py-2 font-medium">定位</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scoringTable.map((row) => (
                            <tr key={row.id} className="border-t border-border">
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => handleItemClick(row.clauseIds, row.id)}
                                  className="flex items-start gap-1.5 text-left text-foreground hover:text-primary"
                                >
                                  {row.star && <Star className="mt-0.5 size-3.5 shrink-0 fill-warning text-warning" />}
                                  <span>
                                    <span className="font-medium">{row.name}</span>
                                    <span className="mt-0.5 block text-xs text-muted-foreground">{row.desc}</span>
                                  </span>
                                </button>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 font-semibold text-primary">{row.score} 分</td>
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => handleItemClick(row.clauseIds, row.id)}
                                  className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground hover:text-primary"
                                  aria-label={`定位到招标原文 ${locate(row.clauseIds)}`}
                                >
                                  <MapPin className="size-3.5" />
                                  {locate(row.clauseIds)}
                                </button>
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t border-border bg-muted/40">
                            <td className="px-3 py-2 font-semibold text-foreground">合计</td>
                            <td className="px-3 py-2 font-bold text-primary" colSpan={2}>
                              {scoringTable.reduce((s, r) => s + r.score, 0)} 分
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-2 flex flex-col gap-2">
                    {cat.items.map((item, idx) => {
                      const key = `${cat.key}-${idx}`
                      const isMissing = item.status === "missing"

                      return (
                        <div
                          key={key}
                          className={`rounded-xl border bg-background p-3 transition-colors ${
                            activeItem === key ? "border-primary ring-1 ring-primary/30" : "border-border"
                          } ${isMissing ? "border-warning/40" : ""}`}
                        >
                          <button
                            onClick={() => item.status === "found" && handleItemClick(item.clauseIds, key)}
                            className="flex w-full items-start gap-2 text-left"
                          >
                            <span className="mt-0.5 shrink-0">
                              {isMissing ? (
                                <AlertTriangle className="size-4 text-warning-foreground" />
                              ) : (
                                <CheckCircle2 className="size-4 text-success" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-medium text-foreground">{item.title}</span>
                                {item.risk && (
                                  <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                                    废标风险
                                  </span>
                                )}
                                {isMissing && (
                                  <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning-foreground">
                                    未发现
                                  </span>
                                )}
                              </span>
                              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                                {item.value}
                              </span>
                              {item.status === "found" && (
                                <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                  <MapPin className="size-3" />
                                  定位 {locate(item.clauseIds)}
                                </span>
                              )}
                            </span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* 投标文件构成（spec321）：旧项目读标结果无该字段时不渲染 */}
      {requiredStructure.length > 0 && (
        <section className="mt-5 rounded-2xl border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <Layers className="size-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold text-foreground">投标文件构成</span>
            <span className="ml-auto text-xs text-muted-foreground">{requiredStructure.length} 项</span>
          </header>
          <div className="flex flex-col gap-2 px-4 py-4">
            {requiredStructure.map((item) => {
              const key = `structure-${item.id}`
              const hasClauses = (item.clauseIds?.length ?? 0) > 0
              return (
                <div
                  key={item.id}
                  className={`rounded-xl border bg-background p-3 transition-colors ${
                    activeItem === key ? "border-primary ring-1 ring-primary/30" : "border-border"
                  }`}
                >
                  <button
                    onClick={() => hasClauses && handleItemClick(item.clauseIds, key)}
                    disabled={!hasClauses}
                    className="flex w-full items-start gap-2 text-left disabled:cursor-default"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${STRUCTURE_KIND_BADGE[item.kind]}`}
                        >
                          {STRUCTURE_KIND_LABEL[item.kind]}
                        </span>
                        <span className="text-sm font-medium text-foreground">{item.title}</span>
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                            item.required
                              ? "bg-destructive/10 text-destructive"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {item.required ? "必备" : "可选"}
                        </span>
                      </span>
                      {item.notes && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{item.notes}</span>
                      )}
                      {hasClauses && (
                        <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          <MapPin className="size-3" />
                          定位 {locate(item.clauseIds)}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 右下角悬浮：进入大纲生成 */}
      <Link
        href="/outline"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full gradient-brand px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-opacity hover:opacity-90"
      >
        <CheckCircle2 className="size-4" />
        已知悉，生成投标文件大纲
        <ArrowRight className="size-4" />
      </Link>
    </div>
  )
}

/* 多包件招标选包卡（spec324）：单选卡片组，选中 → PATCH 选包；下方「再投」按钮 = 兼投多包件入口——
   建项即选包（新项目带着所投的包创建）。takenIds = 兄弟项目已生成大纲的包（一包一份投标文件）：
   置灰不可选；cloneCandidates = 还可再投（未生成）的包。 */
function PackageSelector({
  packages,
  takenIds,
  cloneCandidates,
  selectedId,
  saving,
  message,
  error,
  onSelect,
  onClone,
  cloning,
  cloneError,
}: {
  packages: PackageInfo[]
  takenIds: string[]
  cloneCandidates: PackageInfo[]
  selectedId: string | null
  saving: boolean
  message: string | null
  error: string | null
  onSelect: (pkg: PackageInfo) => void
  onClone: (pkg: PackageInfo) => void
  cloning: boolean
  cloneError: string | null
}) {
  return (
    <section className="mt-5 rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <Boxes className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-semibold text-foreground">选择投标包件</span>
        <span className="ml-auto text-xs text-muted-foreground">多包件招标须先选包才能生成大纲，一次只能投一个包</span>
      </header>
      <div className="flex flex-col gap-2 px-4 py-4">
        {packages.map((pkg) => {
          const selected = selectedId === pkg.id
          const taken = !selected && takenIds.includes(pkg.id)
          return (
            <button
              key={pkg.id}
              onClick={() => !taken && onSelect(pkg)}
              disabled={saving || taken}
              className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-primary/50 gradient-brand-soft"
                  : taken
                    ? "cursor-not-allowed border-border bg-muted/40"
                    : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                  {pkg.name}
                  {pkg.budget && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {pkg.budget}
                    </span>
                  )}
                  {taken && (
                    <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                      已生成大纲（其它项目）
                    </span>
                  )}
                </span>
                {pkg.notes && <span className="mt-1 block text-xs text-muted-foreground">{pkg.notes}</span>}
              </span>
              {selected ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : taken ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success/60" />
              ) : (
                <span className="mt-0.5 size-4 shrink-0 rounded-full border border-border" />
              )}
            </button>
          )
        })}
        {message && <p className="text-xs font-medium text-success">{message}</p>}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">兼投多包件需分开制作投标文件——选要再投的包，新建一个项目：</p>
        {cloneCandidates.length === 0 ? (
          <span className="text-xs text-muted-foreground">所有包件均已生成大纲，无可再投的包</span>
        ) : (
          cloneCandidates.map((pkg) => (
            <button
              key={pkg.id}
              onClick={() => onClone(pkg)}
              disabled={cloning}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
            >
              {cloning && <Loader2 className="size-3.5 animate-spin" />}
              再投「{pkg.name}」
            </button>
          ))
        )}
      </div>
      {cloneError && <p className="px-4 pb-3 text-xs font-medium text-destructive">{cloneError}</p>}
    </section>
  )
}
