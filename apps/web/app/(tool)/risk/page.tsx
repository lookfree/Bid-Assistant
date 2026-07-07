"use client"

import { useEffect, useRef, useState } from "react"
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Upload,
  FileText,
  X,
  Copy,
  Zap,
  Lock,
  EyeOff,
  Flame,
  Loader2,
  RotateCcw,
  ListChecks,
} from "lucide-react"
import { FlowNav } from "@/components/tool/flow-nav"
import { riskFindings } from "@/lib/sample-bid"
import { deriveRisk, type RealRisk } from "@/lib/risk-derive"
import { useStep } from "@/lib/use-step"
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
  // 真实项目：review 步产 RiskReport；未跑则自动触发，跑完直接进 done 视图
  const { projectId, info, data: real, running, error, start } = useStep<RealRisk>("review")
  useEffect(() => {
    if (projectId && info && !real && !running && info.project.currentStep === "review") void start()
  }, [projectId, info, real, running, start])
  const { score, overview, riskItems, passed } = deriveRisk(real ?? riskFindings)

  const [tender, setTender] = useState<string[]>([])
  const [bid, setBid] = useState<string[]>([])
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle")
  const tenderRef = useRef<HTMLInputElement>(null)
  const bidRef = useRef<HTMLInputElement>(null)

  const canRun = tender.length > 0 && bid.length > 0

  function run() {
    setStatus("running")
    setTimeout(() => setStatus("done"), 1600)
  }

  function reset() {
    setTender([])
    setBid([])
    setStatus("idle")
  }

  if (running || error) {
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-6 text-sm">
        {running ? (
          <span className="font-medium text-primary">AI 正在逐条比对招标要求与标书内容，生成废标体检报告…</span>
        ) : (
          <span className="flex items-center justify-between text-destructive">
            {error}
            <button onClick={() => void start()} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">重试</button>
          </span>
        )}
      </div>
    )
  }
  if (real || status === "done") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            已审查 {tender.length} 份招标文件 · {bid.length} 份投标文件
          </p>
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <RotateCcw className="size-3.5" />
            重新审查
          </button>
        </div>

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

  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-8">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg gradient-brand-soft">
          <Zap className="size-4 text-primary" />
        </span>
        <span className="text-sm font-semibold text-foreground">标准版</span>
        <span className="text-xs text-muted-foreground">· 快速便捷</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">上传完整招标文件与投标文件，AI 将自动识别废标风险与潜在问题</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <UploadCard
          title="招标文件 (Tender Doc)"
          hint="支持招标正文、补遗澄清、答疑文件等一起上传"
          files={tender}
          onPick={() => tenderRef.current?.click()}
          onRemove={(i) => setTender((p) => p.filter((_, idx) => idx !== i))}
          accent="primary"
        />
        <UploadCard
          title="投标文件 (Bid Doc)"
          hint="需要进行合规审查的文件，支持多卷投标文件一起上传"
          files={bid}
          onPick={() => bidRef.current?.click()}
          onRemove={(i) => setBid((p) => p.filter((_, idx) => idx !== i))}
          accent="blue"
        />
      </div>

      <input
        ref={tenderRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const names = Array.from(e.target.files ?? []).map((f) => f.name)
          if (names.length) setTender((p) => [...p, ...names])
          e.target.value = ""
        }}
      />
      <input
        ref={bidRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const names = Array.from(e.target.files ?? []).map((f) => f.name)
          if (names.length) setBid((p) => [...p, ...names])
          e.target.value = ""
        }}
      />

      {/* 隐私说明 */}
      <div className="mt-5 grid grid-cols-2 gap-3 rounded-2xl bg-muted/50 px-4 py-3 sm:grid-cols-4">
        <Privacy icon={ShieldCheck} text="浏览器本地存储" tone="text-success" />
        <Privacy icon={Lock} text="不上传到服务器" tone="text-primary" />
        <Privacy icon={EyeOff} text="模型不训练" tone="text-[oklch(0.55_0.15_255)]" />
        <Privacy icon={Flame} text="文件阅后即焚" tone="text-warning" />
      </div>

      <button
        onClick={run}
        disabled={!canRun || status === "running"}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground enabled:gradient-brand enabled:text-white enabled:hover:opacity-90"
      >
        {status === "running" ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            正在审查…
          </>
        ) : canRun ? (
          <>
            <ShieldAlert className="size-4" />
            开始审查
          </>
        ) : (
          "请先上传招标文件与投标文件"
        )}
      </button>
    </div>
  )
}

/* ---------------- 复用小组件 ---------------- */
function UploadCard({
  title,
  hint,
  files,
  onPick,
  onRemove,
  accent,
}: {
  title: string
  hint: string
  files: string[]
  onPick: () => void
  onRemove: (i: number) => void
  accent: "primary" | "blue"
}) {
  const accentBg = accent === "primary" ? "gradient-brand-soft text-primary" : "bg-muted text-muted-foreground"
  return (
    <div className="flex flex-col rounded-2xl border-2 border-dashed border-border p-5">
      <button onClick={onPick} className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
        <span className={`flex size-14 items-center justify-center rounded-2xl ${accentBg}`}>
          <Upload className="size-6" />
        </span>
        <span className="text-base font-semibold text-foreground">{title}</span>
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-primary">点击打开</span> 或拖拽文件至此（.pdf/.docx，可多选）
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
      {files.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {files.map((f, i) => (
            <div key={`${f}-${i}`} className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2">
              <FileText className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{f}</span>
              <button onClick={() => onRemove(i)} className="text-muted-foreground hover:text-destructive">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Privacy({ icon: Icon, text, tone }: { icon: React.ElementType; text: string; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`size-4 shrink-0 ${tone}`} />
      <span className="text-xs text-foreground">{text}</span>
    </div>
  )
}
