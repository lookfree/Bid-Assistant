"use client"

import { useRef, useState } from "react"
import {
  CheckCircle2,
  Copy,
  Database,
  FileText,
  Flame,
  Image as ImageIcon,
  Layers,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react"
import Link from "next/link"
import { CreditEstimate } from "@/components/credit-estimate"
import { ApiError } from "@/lib/api-client"
import { uploadFile, uploadErrorMessage, type UploadedFile } from "@/lib/files"
import { creditCostValue } from "@/lib/membership-view"
import { useMembership } from "@/lib/use-membership"
import { runDedupe, type DedupeDim, type DedupeResult, type DedupeStrategy } from "@/lib/risk-api"
import { toneClass } from "./shared"

/* ---------------- 静态目录 ---------------- */

const dedupDimensions: { id: DedupeDim; name: string; desc: string; icon: React.ElementType; required?: boolean; needTender?: boolean }[] = [
  { id: "text", name: "文本指纹", required: true, desc: "分句指纹召回 + 最长公共子串精排，识破同义改写", icon: FileText },
  { id: "image", name: "图片指纹", desc: "感知哈希比对文档内图片，抓图片复用", icon: ImageIcon },
  { id: "meta", name: "元数据指纹", desc: "作者 · 公司 · 最后修改人等文档属性比对", icon: Database },
  { id: "baseline", name: "招标基线扣除", needTender: true, desc: "从相似度中扣除招标同源段，避免误报", icon: Layers },
]

const strategyLabels: Record<DedupeStrategy, string> = { fast: "快速", standard: "标准", strict: "严格" }

const dimLabels: Record<string, string> = { text: "文本", image: "图片", meta: "元数据", baseline: "基线扣除" }

/** 查重失败 → 用户可读文案（status 供 402 引导充值）。 */
function dedupeError(e: unknown): { status: number | null; msg: string } {
  const status = e instanceof ApiError ? e.status : null
  if (status === 402) return { status, msg: "积分不足，无法开始查重" }
  if (status === 400) return { status, msg: "文件校验失败，请删除后重新上传再试" }
  if (status === 422) return { status, msg: "有文件解析失败：请确认为文本可读的 PDF / Word 文档（扫描件暂不支持）" }
  if (status === 502) return { status, msg: "查重服务暂时不可用，请稍后重试" }
  return { status, msg: "查重失败，请重试" }
}

/* ============== 标书查重 tab ============== */

/** 文件区状态：投标文件（≤3 份）与招标文件的上传/替换，走 /files 三段直传拿对象 key。 */
function useDedupeFiles(setError: (e: { status: number | null; msg: string } | null) => void) {
  const [bids, setBids] = useState<UploadedFile[]>([])
  const [tender, setTender] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState(false)

  async function upload(files: File[], kind: "bid" | "tender") {
    setError(null)
    setUploading(true)
    try {
      for (const f of files.slice(0, kind === "bid" ? 3 - bids.length : 1)) {
        const up = await uploadFile(f)
        if (kind === "bid") setBids((p) => (p.length >= 3 ? p : [...p, up]))
        else setTender(up)
      }
    } catch (e) {
      setError({ status: null, msg: uploadErrorMessage(e, "文件上传失败，请重试") })
    } finally {
      setUploading(false)
    }
  }

  return { bids, setBids, tender, setTender, uploading, upload }
}

/** 查重工作台全部状态与动作（上传/维度/策略/确认/执行），组件只负责渲染。 */
function useDedupeWorkbench() {
  const { overview, balance, reload } = useMembership()
  const cost = creditCostValue(overview, "dedupe", 100)

  const [strategy, setStrategy] = useState<DedupeStrategy>("standard")
  const [dims, setDims] = useState<DedupeDim[]>(["text", "image", "meta"])
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DedupeResult | null>(null)
  const [error, setError] = useState<{ status: number | null; msg: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { bids, setBids, tender, setTender, uploading, upload } = useDedupeFiles(setError)

  function toggleDim(id: DedupeDim) {
    if (id === "text") return // 必选
    setNotice(null)
    setDims((p) => (p.includes(id) ? p.filter((d) => d !== id) : [...p, id]))
  }

  /** 移除招标文件：基线扣除失去前提，一并摘掉并提示（不静默丢弃用户勾选）。 */
  function removeTender() {
    setTender(null)
    if (dims.includes("baseline")) {
      setDims((p) => p.filter((d) => d !== "baseline"))
      setNotice("已移除招标文件，「招标基线扣除」维度已自动取消")
    }
  }

  function onStart() {
    setError(null)
    setNotice(null)
    if (dims.includes("baseline") && !tender) {
      setError({ status: null, msg: "已勾选「招标基线扣除」，请先上传招标文件，或取消该维度后再开始" })
      return
    }
    setConfirming(true)
  }

  async function doRun() {
    setConfirming(false)
    // 确认弹层停留期间设置可能已变（如又移除了招标文件）：开跑前再校验一次 baseline↔tender
    if (dims.includes("baseline") && !tender) {
      setError({ status: null, msg: "已勾选「招标基线扣除」，请先上传招标文件，或取消该维度后再开始" })
      return
    }
    setRunning(true)
    try {
      const r = await runDedupe({
        fileKeys: bids.map((b) => b.key),
        ...(tender ? { tenderKey: tender.key } : {}),
        dims,
        strategy,
      })
      setResult(r)
      reload() // 扣费成功，刷新余额
    } catch (e) {
      setError(dedupeError(e))
    } finally {
      setRunning(false)
    }
  }

  function reset() {
    setBids([])
    setTender(null)
    setResult(null)
    setError(null)
    setNotice(null)
    setConfirming(false)
  }

  return {
    cost, balance, bids, setBids, tender, strategy, setStrategy, dims, uploading,
    confirming, setConfirming, running, result, error, notice,
    toggleDim, upload, removeTender, onStart, doRun, reset,
  }
}

export function DedupReview() {
  const w = useDedupeWorkbench()

  if (w.result) return <DedupeResults result={w.result} count={w.bids.length} strategy={w.strategy} onReset={w.reset} />

  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg gradient-brand-soft">
          <Copy className="size-4 text-primary" />
        </span>
        <span className="text-sm font-semibold text-foreground">查重工作台</span>
        <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2.5 py-1">{w.bids.length}/3 份投标</span>
          <span className="rounded-full bg-muted px-2.5 py-1">维度：{w.dims.length}/4</span>
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">全维比对，精准识别投标雷同风险（文本 · 图片 · 元数据 · 招标基线）</p>

      <PrivacyNote />
      <BidUploader
        bids={w.bids}
        uploading={w.uploading}
        onFiles={(fs) => void w.upload(fs, "bid")}
        onRemove={(i) => w.setBids((p) => p.filter((_, idx) => idx !== i))}
      />
      <TenderPicker tender={w.tender} onFile={(f) => void w.upload([f], "tender")} onRemove={w.removeTender} />
      <StrategyPicker strategy={w.strategy} onChange={w.setStrategy} />
      <DimsPicker dims={w.dims} hasTender={w.tender !== null} onToggle={w.toggleDim} />

      {w.notice && (
        <p className="mt-4 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">{w.notice}</p>
      )}
      <RunBar
        error={w.error}
        confirming={w.confirming}
        cost={w.cost}
        balance={w.balance}
        canRun={w.bids.length >= 2 && !w.uploading}
        running={w.running}
        uploading={w.uploading}
        onStart={w.onStart}
        onConfirm={() => void w.doRun()}
        onCancel={() => w.setConfirming(false)}
      />
    </div>
  )
}

/** 底部动作区：错误提示（402 带去充值）+ 确认消耗弹层 / 开始查重按钮。 */
function RunBar({
  error,
  confirming,
  cost,
  balance,
  canRun,
  running,
  uploading,
  onStart,
  onConfirm,
  onCancel,
}: {
  error: { status: number | null; msg: string } | null
  confirming: boolean
  cost: number
  balance: number
  canRun: boolean
  running: boolean
  uploading: boolean
  onStart: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <>
      {error && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <span>{error.msg}</span>
          {error.status === 402 && (
            <Link href="/membership" className="font-semibold underline underline-offset-2">
              去充值
            </Link>
          )}
        </div>
      )}

      {confirming ? (
        <div className="mt-6">
          <CreditEstimate cost={cost} balance={balance} showSupportable={false} actionLabel="确认并开始查重" onConfirm={onConfirm} />
          <button onClick={onCancel} className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-foreground">
            取消
          </button>
        </div>
      ) : (
        <button
          onClick={onStart}
          disabled={!canRun || running}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground enabled:gradient-brand enabled:text-white enabled:hover:opacity-90"
        >
          {running ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              正在全维比对…
            </>
          ) : uploading ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              文件上传中…
            </>
          ) : canRun ? (
            <>
              <Copy className="size-4" />
              开始查重（{cost} 积分）
            </>
          ) : (
            "请上传至少 2 份投标文件后开始查重"
          )}
        </button>
      )}
    </>
  )
}

/* ---------------- 设置区子组件 ---------------- */

function PrivacyNote() {
  return (
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
  )
}

function BidUploader({
  bids,
  uploading,
  onFiles,
  onRemove,
}: {
  bids: UploadedFile[]
  uploading: boolean
  onFiles: (files: File[]) => void
  onRemove: (i: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading || bids.length >= 3}
        className="mt-5 flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
          {uploading ? <Loader2 className="size-6 animate-spin text-primary" /> : <Upload className="size-6 text-primary" />}
        </span>
        <span className="text-base font-semibold text-foreground">{uploading ? "文件上传中…" : "上传需要查重的投标文件"}</span>
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-primary">点击选择</span> 2 - 3 份投标文件
        </span>
        <span className="text-xs text-muted-foreground">PDF / Word（.docx）· 单文件 ≤ 100 MB</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.docx"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      {bids.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {bids.map((f, i) => (
            <div key={f.fileId} className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{f.name}</span>
              <button onClick={() => onRemove(i)} className="text-muted-foreground hover:text-destructive">
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function TenderPicker({ tender, onFile, onRemove }: { tender: UploadedFile | null; onFile: (f: File) => void; onRemove: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="mt-4 rounded-2xl border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">
            招标文件 <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">可选 · 1 份</span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">用于排除招标同源段落，降低误报</p>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          <Upload className="size-3.5" />
          {tender ? "更换文件" : "添加文件"}
        </button>
      </div>
      {tender && (
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
            <FileText className="size-3" />
            {tender.name}
            <button onClick={onRemove} className="text-muted-foreground hover:text-destructive">
              <X className="size-3" />
            </button>
          </span>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ""
        }}
      />
    </div>
  )
}

function StrategyPicker({ strategy, onChange }: { strategy: DedupeStrategy; onChange: (s: DedupeStrategy) => void }) {
  const descs: Record<DedupeStrategy, string> = {
    fast: "速度优先，命中明显雷同段落，适合投标前快速自查",
    standard: "速度与查全率均衡，覆盖常见雷同，日常场景推荐",
    strict: "查全率优先，可识破同义改写与小段拼接，耗时略长",
  }
  return (
    <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-foreground">查重策略</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{descs[strategy]}</p>
      </div>
      <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
        {(Object.keys(strategyLabels) as DedupeStrategy[]).map((id) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              strategy === id ? "gradient-brand text-white" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {strategyLabels[id]}
          </button>
        ))}
      </div>
    </div>
  )
}

function DimsPicker({ dims, hasTender, onToggle }: { dims: DedupeDim[]; hasTender: boolean; onToggle: (id: DedupeDim) => void }) {
  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-2">
        <p className="text-sm font-semibold text-foreground">查重维度</p>
        <p className="text-xs text-muted-foreground">按需启用 · 已选 {dims.length} / 4</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {dedupDimensions.map((d) => {
          const checked = dims.includes(d.id)
          const disabled = Boolean(d.needTender) && !hasTender
          return (
            <button
              key={d.id}
              onClick={() => !disabled && onToggle(d.id)}
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
  )
}

/* ---------------- 结果区 ---------------- */

function DedupeResults({
  result,
  count,
  strategy,
  onReset,
}: {
  result: DedupeResult
  count: number
  strategy: DedupeStrategy
  onReset: () => void
}) {
  const { overall, pairs, dimsRun } = result
  const overallTone = overall.highPairs > 0 ? "destructive" : overall.maxScore >= 40 ? "warning" : "success"
  const tc = toneClass(overallTone)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          已比对 {count} 份投标文件 · 策略：{strategyLabels[strategy]} · 维度：{dimsRun.map((d) => dimLabels[d] ?? d).join(" / ")}
        </p>
        <button
          onClick={onReset}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          <RotateCcw className="size-3.5" />
          重新查重
        </button>
      </div>

      {/* 总体相似度 */}
      <div className="flex flex-col items-center gap-5 rounded-3xl border border-border bg-card p-8 sm:flex-row sm:gap-8">
        <div className={`flex size-28 shrink-0 flex-col items-center justify-center rounded-full ${tc.badge}`}>
          <span className="text-3xl font-bold">{overall.maxScore}%</span>
          <span className="text-xs text-muted-foreground">最高相似度</span>
        </div>
        <div className="flex-1 text-center sm:text-left">
          <div className="flex items-center justify-center gap-2 sm:justify-start">
            <Flame className={`size-5 ${tc.icon}`} />
            <p className="text-base font-semibold text-foreground">
              {overall.highPairs > 0 ? `检测到 ${overall.highPairs} 组高雷同投标，疑似围标串标风险` : "未检测到高雷同组合"}
            </p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            已按所选维度对上传文件两两交叉比对{dimsRun.includes("baseline") ? "，并扣除招标同源段落" : ""}。
            {overall.highPairs > 0 ? "建议重点核查高相似度组合的命中片段。" : "如仍有疑虑，可换用严格策略复查。"}
          </p>
        </div>
      </div>

      {/* 两两比对结果 */}
      <section className="flex flex-col gap-3">
        {pairs.map((p) => (
          <PairCard key={`${p.a}-${p.b}`} pair={p} />
        ))}
      </section>
    </div>
  )
}

function PairCard({ pair }: { pair: DedupeResult["pairs"][number] }) {
  const tc = toneClass(pair.tone)
  return (
    <div className={`rounded-2xl border bg-card p-5 ${tc.border}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Copy className={`size-5 shrink-0 ${tc.icon}`} />
        <span className="text-sm font-semibold text-foreground">
          {pair.a} <span className="text-muted-foreground">×</span> {pair.b}
        </span>
        <span className={`ml-auto inline-flex items-center rounded-md px-2.5 py-1 text-sm font-bold ${tc.badge}`}>{pair.score}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${pair.tone === "destructive" ? "bg-destructive" : pair.tone === "warning" ? "bg-warning" : "bg-success"}`}
          style={{ width: `${Math.min(100, Math.max(0, pair.score))}%` }}
        />
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{pair.note}</p>
      {pair.hits.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-semibold text-foreground">命中片段（{pair.hits.length}）</p>
          {pair.hits.map((h, i) => (
            <div key={i} className="rounded-xl bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{dimLabels[h.dim] ?? h.dim}</span>
                <span className="text-[11px] text-muted-foreground">{h.detail}</span>
              </div>
              {h.aText && <p className="mt-1.5 text-xs leading-relaxed text-foreground">「{pair.a}」：{h.aText}</p>}
              {h.bText && <p className="mt-1 text-xs leading-relaxed text-foreground">「{pair.b}」：{h.bText}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
