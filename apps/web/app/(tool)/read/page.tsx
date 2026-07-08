"use client"

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
  type LucideIcon,
} from "lucide-react"
import type { AnalysisItem, ScoringRow } from "@/lib/bid-types"
import { useStep } from "@/lib/use-step"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { clauseLocationIn, groupDocSections, type DocSentence } from "@/lib/doc-sections"

// 分类解读类目 icon（agent 结果只带 key，不产 UI 组件），未知 key 兜底 FileText
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  overview: FileText,
  qualification: ShieldCheck,
  commercial: Wallet,
  technical: Cpu,
  scoring: Target,
  format: ClipboardList,
}

// agent ReadResult（App 已转 camelCase）→ 原型渲染形状；icon 按 key 从示例类目合并（agent 不产 UI 组件）。
// docSections = 招标原文分句（spec315a），有真实结果时左栏渲染真实原文。
type RealRead = {
  categories: { key: string; title: string; items: AnalysisItem[] }[]
  scoring?: ScoringRow[]
  riskSummary?: string[]
  docSections?: DocSentence[]
}
import { FlowNav } from "@/components/tool/flow-nav"
import { StepBanner } from "@/components/tool/step-banner"
import { TenderDocPanel } from "@/components/tool/tender-doc-panel"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"


export default function ReadPage() {
  const { projectId, info, data: real, running, error, errorAction, start } = useStep<RealRead>("read")
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
    void start()
  }, [projectId, info, real, running, start])
  // 数据一律来自真实 read 步结果；该步未跑时页面停在显式生成入口，绝不渲染示例
  const categories = useMemo(
    () =>
      real
        ? real.categories.map((c) => ({
            ...c,
            icon: CATEGORY_ICONS[c.key] ?? FileText,
            items: c.items.map((i) => ({ ...i, clauseIds: i.clauseIds ?? [] })),
          }))
        : [],
    [real],
  )
  const scoringTable = real?.scoring ?? []
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
        <FlowNav current="read" />
        <NoProjectGuide />
      </div>
    )

  // 该步未跑：停在显式生成入口（消耗数标注在按钮上），运行中/失败由横幅呈现
  if (!real)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="read" />
        <StepBanner
          running={running}
          error={error}
          runningText="AI 正在通读招标文件，提取评分点与废标红线…（约 1–2 分钟）"
          onRetry={() => void start()}
          action={errorAction ?? undefined}
        />
        {running ? (
          <StepPlaceholder text="读标完成后显示招标原文与分类解读" />
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
      <FlowNav current="read" />
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
            <FileText className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">招标解读</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              AI 通读招标文件，自动提取评分点、资格要求与废标红线，点击逐条定位原文
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <CheckCircle2 className="size-3.5" />
              已识别 {foundCount}
            </span>
            <span className="h-3 w-px bg-border" />
            <span className="inline-flex items-center gap-1 font-medium text-warning-foreground">
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
      </div>

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
