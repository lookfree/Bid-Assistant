"use client"

import { useState } from "react"
import { Sparkles } from "lucide-react"
import { estimatePages, fmtChars } from "@/lib/doc-stats"
import {
  DEFAULT_FORMAT,
  TARGET_MAX,
  TARGET_MIN,
  loadGenConfig,
  saveGenConfig,
  suggestedTarget,
  type DocFormat,
} from "@/lib/generation-config"

const FONTS = ["宋体", "仿宋", "楷体", "黑体"]
const SIZES = ["三号", "四号", "小四", "五号"]

/** 生成配置弹层（spec330）：目标字数滑杆 + 自定义 + 可折叠输出格式;确认后回传配置并记住偏好。 */
export function GenerationConfigDialog({
  chapterCount,
  costText,
  onConfirm,
  onClose,
}: {
  chapterCount: number
  costText: string
  onConfirm: (cfg: { targetChars: number; format: DocFormat }) => void
  onClose: () => void
}) {
  const saved = loadGenConfig()
  const [target, setTarget] = useState<number>(saved.targetChars ?? suggestedTarget(chapterCount))
  const [custom, setCustom] = useState(false)
  const [fmt, setFmt] = useState<DocFormat>({ ...DEFAULT_FORMAT, ...(saved.format ?? {}), margin_cm: { ...DEFAULT_FORMAT.margin_cm, ...(saved.format?.margin_cm ?? {}) } })
  const [fmtOpen, setFmtOpen] = useState(false)

  const clamped = Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(target) || TARGET_MIN))
  function confirm() {
    saveGenConfig({ targetChars: clamped, format: fmt })
    onConfirm({ targetChars: clamped, format: fmt })
  }
  const setF = (patch: Partial<DocFormat>) => setFmt((p) => ({ ...p, ...patch }))
  const setMargin = (k: "top" | "bottom" | "left" | "right", v: number) =>
    setFmt((p) => ({ ...p, margin_cm: { ...DEFAULT_FORMAT.margin_cm, ...p.margin_cm, [k]: v } }))

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <p className="border-l-4 border-primary pl-2 text-sm font-semibold text-foreground">选择标书字数</p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="range"
            min={TARGET_MIN}
            max={TARGET_MAX}
            step={5000}
            value={clamped}
            disabled={custom}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="h-1.5 flex-1 accent-primary"
          />
          <span className="shrink-0 text-sm text-muted-foreground">
            约 <b className="text-primary">{fmtChars(clamped)}字</b> · {estimatePages(clamped)}页
          </span>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} className="accent-primary" />
          自定义标书字数
          {custom && (
            <input
              type="number"
              value={clamped}
              min={TARGET_MIN}
              max={TARGET_MAX}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="w-28 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            />
          )}
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          本标书共 {chapterCount} 章,推荐 {fmtChars(Math.round((chapterCount * 2000) / 1000) * 1000)}~{fmtChars(suggestedTarget(chapterCount))} 字;字数按章节权重分配,AI 内容优先、不注水
        </p>

        <button onClick={() => setFmtOpen((v) => !v)} className="mt-4 text-xs font-medium text-primary hover:underline">
          {fmtOpen ? "▾ 输出格式（导出 Word 生效）" : "▸ 输出格式（导出 Word 生效,默认:宋体小四/1.5倍行距/标准页边距）"}
        </button>
        {fmtOpen && (
          <FormatPanel fmt={fmt} setF={setF} setMargin={setMargin} onReset={() => setFmt({ ...DEFAULT_FORMAT })} />
        )}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">{costText}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted">
              取消
            </button>
            <button
              onClick={confirm}
              className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Sparkles className="size-4" />
              开始生成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* 输出格式面板：页边距 + 标题/正文 字体字号行距缩进 + 恢复默认 */
function FormatPanel({
  fmt,
  setF,
  setMargin,
  onReset,
}: {
  fmt: DocFormat
  setF: (p: Partial<DocFormat>) => void
  setMargin: (k: "top" | "bottom" | "left" | "right", v: number) => void
  onReset: () => void
}) {
  const m = { ...DEFAULT_FORMAT.margin_cm, ...fmt.margin_cm }
  const sel = "rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-background/50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 font-medium text-foreground">页边距</span>
        {(["top", "bottom", "left", "right"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1 text-muted-foreground">
            {{ top: "上", bottom: "下", left: "左", right: "右" }[k]}
            <input type="number" step={0.1} min={0.5} max={6} value={m[k]} onChange={(e) => setMargin(k, Number(e.target.value))} className={`${sel} w-16`} />
          </label>
        ))}
        <span className="text-muted-foreground">cm · A4 纵向</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 font-medium text-foreground">标题</span>
        <select value={fmt.heading_font} onChange={(e) => setF({ heading_font: e.target.value })} className={sel}>
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
        <select value={fmt.heading_size} onChange={(e) => setF({ heading_size: e.target.value })} className={sel}>
          {SIZES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={fmt.heading_bold ?? true} onChange={(e) => setF({ heading_bold: e.target.checked })} className="accent-primary" />
          加粗
        </label>
        <span className="text-muted-foreground">首行缩进0 · 左对齐</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 font-medium text-foreground">正文</span>
        <select value={fmt.body_font} onChange={(e) => setF({ body_font: e.target.value })} className={sel}>
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
        <select value={fmt.body_size} onChange={(e) => setF({ body_size: e.target.value })} className={sel}>
          {SIZES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={String(fmt.body_indent_chars ?? 2)} onChange={(e) => setF({ body_indent_chars: Number(e.target.value) as 0 | 2 })} className={sel}>
          <option value="2">首行缩进2字符</option>
          <option value="0">不缩进</option>
        </select>
        <select
          value={String(fmt.line_spacing ?? 1.5)}
          onChange={(e) => setF({ line_spacing: (e.target.value === "fixed22" ? "fixed22" : Number(e.target.value)) as DocFormat["line_spacing"] })}
          className={sel}
        >
          <option value="1.5">1.5倍行距</option>
          <option value="1">单倍行距</option>
          <option value="fixed22">固定22磅</option>
        </select>
      </div>
      <button onClick={onReset} className="self-start text-xs text-primary hover:underline">恢复默认</button>
    </div>
  )
}
