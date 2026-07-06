"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
  Image as ImageIcon,
  Database,
  Layers,
  ListChecks,
  HelpCircle,
  FileType2,
  FileSpreadsheet,
  FileText as FileDoc,
} from "lucide-react"
import Link from "next/link"
import { CreditEstimate } from "@/components/credit-estimate"
import { FlowNav } from "@/components/tool/flow-nav"
import { creditCosts } from "@/lib/plans"
import { libraryMatch } from "@/lib/library"
import { useLibrary } from "@/lib/use-library"
import { useMembership } from "@/lib/use-membership"
import { riskFindings } from "@/lib/sample-bid"
import { useStep } from "@/lib/use-step"

// agent RiskReport（camelCase）：与原型 riskFindings 同构
type RealRisk = typeof riskFindings

type Tab = "reject" | "dedup" | "checklist"

/** 审核表导出消耗积分（沿用导出口径） */
const CHECKLIST_EXPORT_COST = creditCosts.find((c) => c.feature.startsWith("导出"))?.value ?? 20

/* ---------------- 废标风险审查数据（真实项目用 review 步结果，否则示例） ---------------- */
function deriveRisk(f: RealRisk) {
  return {
    score: f.score,
    overview: [
      { label: "高风险", value: f.high, tone: "destructive" },
      { label: "中风险", value: f.mid, tone: "warning" },
      { label: "已通过", value: f.passed, tone: "success" },
    ],
    riskItems: f.items.map((x) => ({ level: x.level, tone: x.tone, title: x.title, chapter: x.tenderRef, advice: x.advice })),
    passed: f.passedItems,
  }
}

const toneClasses: Record<string, { badge: string; icon: string; border: string }> = {
  destructive: { badge: "bg-destructive/10 text-destructive", icon: "text-destructive", border: "border-destructive/30" },
  warning: { badge: "bg-warning/15 text-warning-foreground", icon: "text-warning", border: "border-warning/30" },
  success: { badge: "bg-success/10 text-success", icon: "text-success", border: "border-success/30" },
}

/* ---------------- 标书查重数据 ---------------- */
const dedupDimensions = [
  { id: "text", name: "文本指纹", required: true, desc: "MinHash·LSH 召回 + LCS 精排，识破同义改写", icon: FileText },
  { id: "image", name: "图片指纹", desc: "dHash + aHash 联合 128 位感知哈希，抓图片复用", icon: ImageIcon },
  { id: "meta", name: "元数据指纹", desc: "作者 · 公司 · 修改人 · 时间 · SimHash 整体指纹", icon: Database },
  { id: "baseline", name: "招标基线扣除", needTender: true, desc: "从相似度中扣除招标同源段，避免误报", icon: Layers },
]

const dedupResults = [
  { a: "投标文件 A", b: "投标文件 B", score: 68, tone: "destructive", note: "技术方案 2.1-2.4 节高度雷同，疑似同源" },
  { a: "投标文件 A", b: "投标文件 C", score: 31, tone: "warning", note: "商务承诺段落部分重合，建议人工复核" },
  { a: "投标文件 B", b: "投标文件 C", score: 12, tone: "success", note: "相似度较低，未发现明显雷同" },
]

/* ---------------- 终极审核表（投递前清单）数据 ---------------- */
const checklistGroups: { id: string; title: string; items: string[] }[] = [
  {
    id: "A",
    title: "资格与资质",
    items: [
      "营业执照有效且经营范围覆盖",
      "招标要求资质证书齐全（如 ISO 体系 / 行业资质 / 安全生产许可）",
      "近三年类似业绩满足数量金额并附合同验收",
      "财务 / 审计报告满足",
      "未被列入失信被执行人 / 重大税收违法 / 政府采购严重违法失信名单",
      "社保与依法纳税证明齐全",
    ],
  },
  {
    id: "B",
    title: "投标保证金",
    items: [
      "金额与招标一致",
      "形式符合（转账 / 银行保函 / 电子保函）",
      "截止前到账且户名账号正确",
      "保函有效期覆盖投标有效期",
    ],
  },
  {
    id: "C",
    title: "签字与盖章",
    items: [
      "法定代表人签字盖章",
      "法人授权委托书（委托代理时）",
      "投标函 / 报价表 / 承诺函等关键页签章",
      "公章 / 骑缝章 / 每页章按要求",
      "复印件加盖公章并注明「与原件一致」",
    ],
  },
  {
    id: "D",
    title: "报价",
    items: [
      "唯一报价，无选择性 / 附条件",
      "不超过最高限价 / 预算",
      "不低于成本（避免恶意低价废标）",
      "大小写金额一致",
      "分项合计与总价一致，无算术错误",
      "报价表无漏项缺项",
    ],
  },
  {
    id: "E",
    title: "实质性响应（不可偏离★项）",
    items: [
      "带 ★ / ▲ 技术参数全部满足，无负偏离",
      "商务条款（工期 / 质保 / 付款）满足",
      "关键否决项逐条核对",
      "技术偏离表与商务偏离表如实填写",
    ],
  },
  {
    id: "F",
    title: "格式与完整性",
    items: [
      "按招标目录顺序编排",
      "正本 / 副本份数正确并标注",
      "电子版（U 盘 / 电子投标文件）齐全可读",
      "密封 / 装订 / 封面标识符合",
      "投标有效期满足",
    ],
  },
  {
    id: "G",
    title: "时间与递交",
    items: [
      "投标截止时间地点确认",
      "递交方式（现场 / 电子平台）确认",
      "关键证明材料（检测报告 / 认证 / 授权 / 样品）齐备",
    ],
  },
  {
    id: "H",
    title: "唯一性与合规",
    items: [
      "同一项目不重复投标",
      "无串标围标关联（可联动查重结果）",
      "联合体协议（如适用）齐全有效",
    ],
  },
]

type CheckStatus = "pass" | "risk" | "pending"

const statusMeta: Record<CheckStatus, { label: string; badge: string; dot: string }> = {
  pass: { label: "通过", badge: "bg-success/10 text-success", dot: "bg-success" },
  risk: { label: "风险", badge: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
  pending: { label: "待确认", badge: "bg-warning/15 text-warning-foreground", dot: "bg-warning" },
}

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

/* ============== 标书查重 ============== */
function DedupReview() {
  const [bids, setBids] = useState<string[]>([])
  const [tender, setTender] = useState<string[]>([])
  const [strategy, setStrategy] = useState<"fast" | "standard" | "strict">("standard")
  const [dims, setDims] = useState<string[]>(["text", "image", "meta"])
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle")
  const bidsRef = useRef<HTMLInputElement>(null)
  const tenderRef = useRef<HTMLInputElement>(null)

  const canRun = bids.length >= 2

  function toggleDim(id: string) {
    if (id === "text") return // 必选
    setDims((p) => (p.includes(id) ? p.filter((d) => d !== id) : [...p, id]))
  }

  function run() {
    setStatus("running")
    setTimeout(() => setStatus("done"), 1800)
  }

  function reset() {
    setBids([])
    setTender([])
    setStatus("idle")
  }

  if (status === "done") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">已比对 {bids.length} 份投标文件 · 策略：{strategy === "fast" ? "快速" : strategy === "strict" ? "严格" : "标准"}</p>
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <RotateCcw className="size-3.5" />
            重新查重
          </button>
        </div>

        {/* 总体相似度 */}
        <div className="flex flex-col items-center gap-5 rounded-3xl border border-border bg-card p-8 sm:flex-row sm:gap-8">
          <div className="flex size-28 shrink-0 flex-col items-center justify-center rounded-full bg-destructive/10">
            <span className="text-3xl font-bold text-destructive">68%</span>
            <span className="text-xs text-muted-foreground">最高相似度</span>
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              <Flame className="size-5 text-destructive" />
              <p className="text-base font-semibold text-foreground">检测到 1 组高雷同投标，疑似围标串标风险</p>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              已对文本、图片、元数据指纹进行全维度交叉验证，并扣除招标同源段落。建议重点核查高相似度组合。
            </p>
          </div>
        </div>

        {/* 两两比对结果 */}
        <section className="flex flex-col gap-3">
          {dedupResults.map((r) => (
            <div key={`${r.a}-${r.b}`} className={`rounded-2xl border bg-card p-5 ${toneClasses[r.tone].border}`}>
              <div className="flex flex-wrap items-center gap-3">
                <Copy className={`size-5 shrink-0 ${toneClasses[r.tone].icon}`} />
                <span className="text-sm font-semibold text-foreground">
                  {r.a} <span className="text-muted-foreground">×</span> {r.b}
                </span>
                <span className={`ml-auto inline-flex items-center rounded-md px-2.5 py-1 text-sm font-bold ${toneClasses[r.tone].badge}`}>
                  {r.score}%
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${
                    r.tone === "destructive" ? "bg-destructive" : r.tone === "warning" ? "bg-warning" : "bg-success"
                  }`}
                  style={{ width: `${r.score}%` }}
                />
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{r.note}</p>
            </div>
          ))}
        </section>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg gradient-brand-soft">
          <Copy className="size-4 text-primary" />
        </span>
        <span className="text-sm font-semibold text-foreground">查重工作台</span>
        <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2.5 py-1">{bids.length}/3 份投标</span>
          <span className="rounded-full bg-muted px-2.5 py-1">维度：{dims.length}/4</span>
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">全维比对，精准识别投标雷同风险（文本 · 图片 · 元数据 · 招标基线）</p>

      {/* 查重隐私声明 */}
      <div className="mt-5 rounded-2xl border border-success/30 bg-success/5 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-success">
          <ShieldCheck className="size-4" />
          隐私与查重范围说明
        </div>
        <p className="mt-2 text-xs leading-relaxed text-foreground">
          你上传的文件<span className="font-medium">仅用于本次你自己发起的比对</span>，不会进入任何公共比对库、不会被他人查重命中、比对后即焚。
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          查重对象：仅在<span className="font-medium text-foreground">你本次上传的 2–3 份投标文件之间</span>两两比对（可选叠加你上传的招标文件做基线扣除），
          <span className="font-medium text-foreground">不与任何第三方 / 历史标书库比对</span>，并非「全网查重」。
        </p>
      </div>

      {/* 投标文件上传区 */}
      <button
        onClick={() => bidsRef.current?.click()}
        className="mt-5 flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:border-primary/50 hover:bg-primary/5"
      >
        <span className="flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
          <Upload className="size-6 text-primary" />
        </span>
        <span className="text-base font-semibold text-foreground">上传需要查重的投标文件</span>
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-primary">点击选择</span> 或拖拽 2 - 3 份投标文件至此
        </span>
        <span className="text-xs text-muted-foreground">.pdf / .doc / .docx · 单文件 ≤ 100 MB</span>
      </button>
      <input
        ref={bidsRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const names = Array.from(e.target.files ?? []).map((f) => f.name)
          if (names.length) setBids((p) => [...p, ...names].slice(0, 3))
          e.target.value = ""
        }}
      />

      {/* 已选投标文件 */}
      {bids.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {bids.map((f, i) => (
            <div key={`${f}-${i}`} className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{f}</span>
              <button onClick={() => setBids((p) => p.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 招标文件（可选） */}
      <div className="mt-4 rounded-2xl border border-border bg-background p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">
              招标文件 <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">可选</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">用于排除招标同源段落，降低误报</p>
          </div>
          <button
            onClick={() => tenderRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Upload className="size-3.5" />
            添加文件
          </button>
        </div>
        {tender.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {tender.map((f, i) => (
              <span key={`${f}-${i}`} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
                <FileText className="size-3" />
                {f}
                <button onClick={() => setTender((p) => p.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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

      {/* 查重策略 */}
      <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">查重策略</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {
              {
                fast: "速度优先，命中明显雷同段落，适合投标前快速自查",
                standard: "速度与查全率均衡，覆盖常见雷同，日常场景推荐",
                strict: "查全率优先，可识破同义改写与小段拼接，耗时略长",
              }[strategy]
            }
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
          {[
            { id: "fast", label: "快速" },
            { id: "standard", label: "标准" },
            { id: "strict", label: "严格" },
          ].map((s) => (
            <button
              key={s.id}
              onClick={() => setStrategy(s.id as typeof strategy)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                strategy === s.id ? "gradient-brand text-white" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 查重维度 */}
      <div className="mt-4">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold text-foreground">查重维度</p>
          <p className="text-xs text-muted-foreground">按需启用 · 已选 {dims.length} / 4</p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {dedupDimensions.map((d) => {
            const checked = dims.includes(d.id)
            const disabled = d.needTender && tender.length === 0
            return (
              <button
                key={d.id}
                onClick={() => !disabled && toggleDim(d.id)}
                disabled={disabled}
                className={`flex flex-col gap-2 rounded-2xl border p-4 text-left transition-colors disabled:opacity-50 ${
                  checked ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-background hover:border-primary/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`flex size-9 items-center justify-center rounded-lg ${checked ? "gradient-brand text-white" : "bg-muted text-muted-foreground"}`}>
                    <d.icon className="size-4" />
                  </span>
                  <span className={`flex size-5 items-center justify-center rounded-md border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                    {checked && <CheckCircle2 className="size-3.5" />}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-foreground">{d.name}</span>
                  {d.required && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">必选</span>}
                  {d.needTender && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">需招标文件</span>}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{d.desc}</p>
              </button>
            )
          })}
        </div>
      </div>

      <button
        onClick={run}
        disabled={!canRun || status === "running"}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground enabled:gradient-brand enabled:text-white enabled:hover:opacity-90"
      >
        {status === "running" ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            正在全维比对…
          </>
        ) : canRun ? (
          <>
            <Copy className="size-4" />
            开始查重
          </>
        ) : (
          "请上传至少 2 份投标文件后开始查重"
        )}
      </button>
    </div>
  )
}

/* ============== 终极审核表（投递前清单） ============== */
function Checklist() {
  /* 真实积分余额（导出预估用）与真实资料库条目（「资料库已具备」联动判定用） */
  const { balance } = useMembership()
  const { items: libItems } = useLibrary()

  // 以 "组id-序号" 为键存每项状态、责任人、备注
  const allKeys = useMemo(
    () => checklistGroups.flatMap((g) => g.items.map((_, i) => `${g.id}-${i}`)),
    [],
  )
  const total = allKeys.length

  const [statusMap, setStatusMap] = useState<Record<string, CheckStatus>>({})
  const [ownerMap, setOwnerMap] = useState<Record<string, string>>({})
  const [noteMap, setNoteMap] = useState<Record<string, string>>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState("")

  const passedCount = allKeys.filter((k) => statusMap[k] === "pass").length
  const riskCount = allKeys.filter((k) => statusMap[k] === "risk").length
  const pendingCount = total - passedCount - riskCount
  const progress = Math.round((passedCount / total) * 100)

  function setStatus(key: string, s: CheckStatus) {
    setStatusMap((p) => ({ ...p, [key]: p[key] === s ? "pending" : s }))
  }

  function doExport(format: "word" | "pdf" | "excel") {
    const name = format === "word" ? "Word" : format === "pdf" ? "PDF" : "Excel"
    setExportOpen(false)
    setExportStatus(`正在导出审核表（${name}）…`)
    setTimeout(() => {
      setExportStatus(`已导出签字版审核表（${name}）`)
      setTimeout(() => setExportStatus(""), 2500)
    }, 900)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部说明 + 进度 */}
      <div className="rounded-3xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
              <ListChecks className="size-5 text-primary" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">投递前终极审核表</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                逐项核对并标注状态、责任人与备注，完成后可导出签字版审核表存档
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="text-right">
              <p className="text-2xl font-bold text-gradient-brand">
                {passedCount}
                <span className="text-base font-medium text-muted-foreground"> / {total}</span>
              </p>
              <p className="text-xs text-muted-foreground">已通过</p>
            </div>
            <div className="flex flex-col gap-1 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-destructive" /> 风险 {riskCount}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-warning" /> 待确认 {pendingCount}
              </span>
            </div>
          </div>
        </div>

        {/* 进度条 */}
        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full gradient-brand transition-all" style={{ width: `${progress}%` }} />
        </div>
        {riskCount > 0 && (
          <p className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3.5" />
            存在 {riskCount} 项风险未处理，建议处理后再递交
          </p>
        )}
      </div>

      {/* 分组清单 */}
      {checklistGroups.map((g) => (
        <section key={g.id} className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-5 py-3">
            <span className="flex size-6 items-center justify-center rounded-md gradient-brand text-xs font-bold text-white">
              {g.id}
            </span>
            <h3 className="text-sm font-semibold text-foreground">{g.title}</h3>
            <span className="ml-auto text-xs text-muted-foreground">{g.items.length} 项</span>
          </div>
          <div className="divide-y divide-border">
            {g.items.map((item, i) => {
              const key = `${g.id}-${i}`
              const cur = statusMap[key] ?? "pending"
              return (
                <div key={key} className="flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center">
                  {/* 检查项 */}
                  <div className="flex flex-1 items-start gap-2">
                    <span className={`mt-1.5 size-2 shrink-0 rounded-full ${statusMeta[cur].dot}`} />
                    <div className="min-w-0">
                      <span className="text-sm leading-relaxed text-foreground">{item}</span>
                      {(() => {
                        const lib = libraryMatch(item, libItems)
                        if (!lib) return null
                        return lib.has ? (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-success">
                            <CheckCircle2 className="size-3" />
                            资料库已具备 · {lib.label}
                          </span>
                        ) : (
                          <Link
                            href="/library"
                            className="ml-2 inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-destructive transition-opacity hover:opacity-80"
                          >
                            <X className="size-3" />
                            资料库缺失 · 去补充
                          </Link>
                        )
                      })()}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
                    {/* 状态切换 */}
                    <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                      {(["pass", "risk", "pending"] as CheckStatus[]).map((s) => (
                        <button
                          key={s}
                          onClick={() => setStatus(key, s)}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                            cur === s ? statusMeta[s].badge : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {statusMeta[s].label}
                        </button>
                      ))}
                    </div>

                    {/* 责任人 */}
                    <input
                      value={ownerMap[key] ?? ""}
                      onChange={(e) => setOwnerMap((p) => ({ ...p, [key]: e.target.value }))}
                      placeholder="责任人"
                      className="w-24 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                    />
                    {/* 备注 */}
                    <input
                      value={noteMap[key] ?? ""}
                      onChange={(e) => setNoteMap((p) => ({ ...p, [key]: e.target.value }))}
                      placeholder="备注"
                      className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {/* 导出区 */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <CreditEstimate
          cost={CHECKLIST_EXPORT_COST}
          balance={balance}
          showSupportable={false}
          actionLabel="导出签字版审核表"
          onConfirm={() => setExportOpen((v) => !v)}
        />
        {exportStatus && <p className="mt-3 text-center text-xs font-medium text-primary">{exportStatus}</p>}
        {exportOpen && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <button
              onClick={() => doExport("word")}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileDoc className="size-4 text-primary" />
              Word
            </button>
            <button
              onClick={() => doExport("pdf")}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileType2 className="size-4 text-destructive" />
              PDF
            </button>
            <button
              onClick={() => doExport("excel")}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileSpreadsheet className="size-4 text-success" />
              Excel
            </button>
          </div>
        )}
        <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <HelpCircle className="size-3.5" />
          导出文件含签字栏与日期栏，可打印盖章存档
        </p>
      </div>
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
