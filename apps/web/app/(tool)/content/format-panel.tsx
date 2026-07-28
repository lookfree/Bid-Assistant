"use client"

import {
  DEFAULT_FORMAT,
  FONT_OPTIONS,
  SIZE_OPTIONS,
  type DocFormat,
} from "@/lib/generation-config"

/* 输出格式面板：页边距 + 标题/正文 字体字号行距缩进 + 恢复默认 */
export function FormatPanel({
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
          {FONT_OPTIONS.map((f) => <option key={f}>{f}</option>)}
        </select>
        <select value={fmt.heading_size} onChange={(e) => setF({ heading_size: e.target.value })} className={sel}>
          {SIZE_OPTIONS.map((s) => <option key={s}>{s}</option>)}
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
          {FONT_OPTIONS.map((f) => <option key={f}>{f}</option>)}
        </select>
        <select value={fmt.body_size} onChange={(e) => setF({ body_size: e.target.value })} className={sel}>
          {SIZE_OPTIONS.map((s) => <option key={s}>{s}</option>)}
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
