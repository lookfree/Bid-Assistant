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
  UploadCloud,
} from "lucide-react"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { ReviewEntry } from "./review-entry"
import { RejectUploadPanel } from "./reject-upload-panel"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"
import { AiNotice } from "@/components/tool/ai-notice"
import { deriveRisk, type RealRisk } from "@/lib/risk-derive"
import { AdviceLockHint } from "@/components/tool/advice-lock-hint"
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
      <StepPageHeader icon={ShieldCheck} title="标书审查" desc="废标风险审查 + 标书查重，交付前帮你拦住风险" />

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
  // review 步产 RiskReport（计费步）：绝不自动触发，一律用户显式点击「开始废标体检」才跑。
  // 默认统一进入独立审查入口（选已生成项目 / 上传线下标书），不默认衔接当前项目已生成的标书；
  // ?view=project = 用户已在入口显式选「当前项目直连审查」（入口内返回/选项目/传标书后跳这里）。
  // 本组件在 RequireAuth 之后才客户端挂载，惰性读 URL 参数无 SSR 水合问题。
  const [viewParam] = useState(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view")),
  )
  const goEntry = () => { window.location.href = "/risk?view=entry" }
  const { projectId, info, data: real, dataLoading, running, phase, error, errorAction, start } = useStep<RealRisk>("review")
  const { overview: membershipOverview } = useMembership()
  const reviewCost = creditCostValue(membershipOverview, "review", 60)

  // ?view=entry：用户从面板里点了「从我的标书选择」，给「选项目 / 传标书」的中转页。
  // 「返回当前项目的审查」仅在当前项目确可审查时给出——否则不给，避免对未生成正文的在途项目
  // 给一个点了会空转回入口的死链（整页跳转带 ?view=project）。
  if (viewParam === "entry")
    return (
      <ReviewEntry
        onBack={projectId && info && !stepPrereq(info, "review") ? () => { window.location.href = "/risk?view=project" } : undefined}
      />
    )
  // 没有当前项目：只能传文件（选项目那张卡在中转页里，由上面的次要入口进）
  if (!projectId) return <RejectUploadPanel onPickExisting={goEntry} />

  // 项目状态/审查报告加载中：数据未就绪绝不裸露「开始废标体检」计费按钮
  if (!info || dataLoading) return <StepPlaceholder text={dataLoading ? "正在加载审查报告…" : "正在加载项目…"} delayMs={250} />

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

  // 该步未跑：
  // - 前序（标书生成）未完成 → 不再引导「前往标书生成」，直接给独立审查入口：标书审查是独立能力，
  //   上传线下标书 / 选已有标书即可审查，不强制先在库内生成。
  // - 前序已就绪 → 给显式体检按钮（明示消耗）+ 顶部独立审查入口条。
  // 该步未跑（用户要求：入口就是双上传面板）：
  // - 前序（标书生成）未完成 → 只有上传面板：审查是独立能力，不强制先在库内生成正文。
  // - 前序已就绪 → 面板之上再给一张「直接审查当前项目」的卡：本项目的招标文件与正文都在库里，
  //   不该逼用户把已有的东西重传一遍（六步流水线的正常下一步，丢了就断链）。
  if (!real) {
    const gap = stepPrereq(info, "review")
    return (
      <div className="flex flex-col gap-3">
        {/* 刚传完文件建好项目、正在读标时回到本页，原来只剩一张空白上传面板——
            用户会以为"刚才没传成功"再传一遍，等于重复付一次读标钱。明确告诉他项目在哪。 */}
        {gap && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/30 gradient-brand-soft px-4 py-3 text-sm">
            <span className="text-foreground">
              当前项目「{info?.project.name ?? "我的标书"}」还差一步：{gap.label}完成后即可体检，无需重新上传
            </span>
            <a href={gap.href} className="shrink-0 rounded-lg gradient-brand px-3 py-1.5 text-xs font-semibold text-white">
              前往{gap.label}
            </a>
          </div>
        )}
        {!gap && (
          <div className="rounded-2xl border border-border bg-card">
            <StepRunCta
              title="审查当前项目"
              desc="直接取本项目的招标文件与已生成正文逐条比对，生成健康分、风险项与整改建议（无需重新上传）"
              costText={`消耗 ${reviewCost} 积分`}
              actionLabel="开始废标体检"
              onRun={() => void start()}
            />
          </div>
        )}
        <RejectUploadPanel onPickExisting={goEntry} />
      </div>
    )
  }

  const { score, overview, riskItems, passed, adviceLocked } = deriveRisk(real)
  return (
    <div className="flex flex-col gap-6">
        <EntryBar onOpen={goEntry} />
        <AiNotice />
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
                    {adviceLocked ? (
                      // 非会员整改建议由服务端裁剪不下发（评审修正）,与体检弹层同一套解锁引导
                      <AdviceLockHint />
                    ) : (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">整改建议：</span>
                        {item.advice}
                      </p>
                    )}
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

/* 独立审查入口条：挂着项目时也能一键切到「选标书/上传线下标书」（防止只有查重 tab 可见上传的误解） */
function EntryBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex justify-end">
      <button
        onClick={onOpen}
        className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 gradient-brand-soft px-4 py-2 text-sm font-semibold text-primary transition-opacity hover:opacity-90"
      >
        <UploadCloud className="size-4" />
        审查其它标书 / 上传线下标书 →
      </button>
    </div>
  )
}
