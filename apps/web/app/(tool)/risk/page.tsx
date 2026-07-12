"use client"

import { useState } from "react"
import Link from "next/link"
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Copy,
  ListChecks,
} from "lucide-react"
import { FlowNav } from "@/components/tool/flow-nav"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"
import { deriveRisk, type RealRisk } from "@/lib/risk-derive"
import { stepPrereq, useStep } from "@/lib/use-step"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { Checklist } from "./checklist"
import { DedupReview } from "./dedup-review"
import { toneClasses } from "./shared"

type Tab = "reject" | "dedup" | "checklist"

export default function ReviewPage() {
  const [tab, setTab] = useState<Tab>("reject")

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <FlowNav current="risk" />
      {/* 标题栏 */}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
            <ShieldCheck className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">标书审查</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">废标风险审查 + 标书查重，交付前帮你拦住风险</p>
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="mt-5 flex gap-2">
        <button
          onClick={() => setTab("reject")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "reject" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <ShieldAlert className="size-4" />
          废标风险审查
        </button>
        <button
          onClick={() => setTab("dedup")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "dedup" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <Copy className="size-4" />
          标书查重
        </button>
        <button
          onClick={() => setTab("checklist")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "checklist" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <ListChecks className="size-4" />
          终极审核表
        </button>
      </div>

      <div className="mt-5">
        {tab === "reject" ? <RejectReview /> : tab === "dedup" ? <DedupReview /> : <Checklist />}
      </div>
    </div>
  )
}

/* ============== 废标风险审查 ============== */
function RejectReview() {
  // review 步产 RiskReport（计费步）：绝不自动触发，一律用户显式点击「开始废标体检」才跑
  const { projectId, info, data: real, running, phase, error, errorAction, start } = useStep<RealRisk>("review")
  const { overview: membershipOverview } = useMembership()
  const reviewCost = creditCostValue(membershipOverview, "review", 60)

  // 无进行中项目：只引导上传，不渲染任何示例内容
  if (!projectId) return <NoProjectGuide />

  if (running || error) {
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-6 text-sm">
        {running ? (
          <span className="font-medium text-primary">{phase ? `AI ${phase.label}…（约 1–2 分钟）` : "AI 正在逐条比对招标要求与标书内容，生成废标体检报告…（约 1–2 分钟）"}</span>
        ) : (
          <span className="flex items-center justify-between text-destructive">
            {error}
            {errorAction ? (
              <Link href={errorAction.href} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
                {errorAction.label}
              </Link>
            ) : (
              <button onClick={() => void start()} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">重试</button>
            )}
          </span>
        )}
      </div>
    )
  }

  // 该步未跑：前序未完成先引导补齐；已就绪给显式体检按钮（明示消耗）
  if (!real) {
    const prereq = stepPrereq(info, "review")
    return (
      <div className="rounded-2xl border border-border bg-card">
        {prereq ? (
          <StepPlaceholder
            text={`请先完成前序步骤：${prereq.label}，再进行废标体检`}
            action={{ href: prereq.href, label: `前往${prereq.label}` }}
          />
        ) : (
          <StepRunCta
            title="废标风险审查"
            desc="AI 逐条比对招标要求与标书内容，生成健康分、风险项与整改建议"
            costText={`消耗 ${reviewCost} 积分`}
            actionLabel="开始废标体检"
            onRun={() => void start()}
          />
        )}
      </div>
    )
  }

  const { score, overview, riskItems, passed } = deriveRisk(real)
  return (
    <div className="flex flex-col gap-6">
        {/* 健康分 */}
        <div className="flex flex-col items-center gap-5 rounded-3xl border border-border bg-card p-8 sm:flex-row sm:gap-8">
          <div className="flex size-28 shrink-0 flex-col items-center justify-center rounded-full gradient-brand-soft">
            <span className="text-3xl font-bold text-gradient-brand">{score}</span>
            <span className="text-xs text-muted-foreground">健康分</span>
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              <ShieldAlert className="size-5 text-warning" />
              <p className="text-base font-semibold text-foreground">
                {overview[0].value > 0 ? `发现 ${overview[0].value} 项高风险，建议处理后再交付` : "未发现高风险项"}
              </p>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {overview.map((o) => (
                <div key={o.label} className="rounded-xl border border-border bg-background py-3 text-center">
                  <p className={`text-xl font-bold ${toneClasses[o.tone].icon}`}>{o.value}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{o.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 风险项 */}
        <section className="flex flex-col gap-3">
          {riskItems.map((item) => (
            <div key={item.title} className={`rounded-2xl border bg-card p-5 ${toneClasses[item.tone].border}`}>
              <div className="flex items-start gap-3">
                <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${toneClasses[item.tone].icon}`} />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${toneClasses[item.tone].badge}`}>
                      {item.level}
                    </span>
                    <span className="text-xs text-muted-foreground">{item.chapter}</span>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-foreground">{item.title}</h3>
                  <div className="mt-3 flex items-start gap-2 rounded-xl bg-secondary/60 p-3">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">整改建议：</span>
                      {item.advice}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* 已通过 */}
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-success" />
            <h2 className="text-base font-semibold text-foreground">已通过检查项</h2>
          </div>
          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {passed.map((p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-foreground">
                <CheckCircle2 className="size-4 shrink-0 text-success" />
                {p}
              </li>
            ))}
          </ul>
        </section>
      </div>
  )
}
