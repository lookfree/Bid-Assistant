"use client"

import { useEffect, useRef, useState } from "react"
import { Sparkles } from "lucide-react"
import { estimatePages, fmtChars } from "@/lib/doc-stats"
import { useOtherStepResult } from "@/lib/use-step"
import type { ProjectInfo } from "@/lib/project"
import {
  DEFAULT_FORMAT,
  FONT_OPTIONS,
  SIZE_OPTIONS,
  TARGET_MAX,
  TARGET_MIN,
  loadGenConfig,
  parseBudgetYuan,
  sanitizeFormat,
  saveGenConfig,
  suggestedTarget,
  type DocFormat,
} from "@/lib/generation-config"

/** 生成配置弹层（spec330）：目标字数滑杆 + 自定义 + 可折叠输出格式;确认后回传配置并记住偏好。 */
export function GenerationConfigDialog({
  chapterCount,
  costText,
  projectId,
  info,
  onConfirm,
  onClose,
}: {
  chapterCount: number
  costText: string
  projectId: string | null
  info: ProjectInfo | null
  onConfirm: (cfg: { targetChars: number; format: DocFormat }) => void
  onClose: () => void
}) {
  // 读标预算懒拉：弹层挂载=用户打开配置时才拉，不在 content 首屏拽 ~1MB 读标结果。
  const { data: readMeta } = useOtherStepResult<{ projectMeta?: { budget?: string } }>(projectId, info, "read")
  const budget = readMeta?.projectMeta?.budget
  const budgetYuan = parseBudgetYuan(budget)
  const suggested = suggestedTarget(chapterCount, budget)
  // localStorage 只在挂载时读一次（存过偏好则优先，且预算到达也不覆盖用户偏好）
  const savedTarget = useRef<number | undefined>(loadGenConfig().targetChars).current
  const [target, setTarget] = useState<number>(() => savedTarget ?? suggested)
  const touched = useRef(false) // 用户是否手动改过——避免预算异步到达后覆盖用户已调的值
  // 预算异步到达后，用户没存过偏好、也没手动改过 → 用预算推荐值刷新初始（否则停在章数推荐）。
  useEffect(() => {
    if (savedTarget == null && !touched.current) setTarget(suggested)
  }, [suggested, savedTarget])
  const [custom, setCustom] = useState(false)
  // 自定义输入用「原始字符串」状态：受控值若绑夹位后的数字,逐位输入会被强改（审查实测 15000 打成 100005）
  const [customText, setCustomText] = useState("")
  const [fmt, setFmt] = useState<DocFormat>(() => sanitizeFormat(loadGenConfig().format ?? {}))
  const [fmtOpen, setFmtOpen] = useState(false)

  const raw = custom ? Number(customText) : target
  const clamped = Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(raw) || TARGET_MIN))
  function confirm() {
    const clean = sanitizeFormat(fmt) // 确认时消毒（夹边距/回落非法枚举）,坏值绝不进 localStorage
    saveGenConfig({ targetChars: clamped, format: clean })
    onConfirm({ targetChars: clamped, format: clean })
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
            onChange={(e) => {
              touched.current = true
              setTarget(Number(e.target.value))
            }}
            className="h-1.5 flex-1 accent-primary"
          />
          <span className="shrink-0 text-sm text-muted-foreground">
            约 <b className="text-primary">{fmtChars(clamped)}字</b> · {estimatePages(clamped)}页
          </span>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              touched.current = true
              setCustom(e.target.checked)
              if (e.target.checked) setCustomText(String(target))
            }}
            className="accent-primary"
          />
          自定义标书字数
          {custom && (
            <input
              type="number"
              value={customText}
              min={TARGET_MIN}
              max={TARGET_MAX}
              onChange={(e) => setCustomText(e.target.value)}
              className="w-28 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            />
          )}
          {custom && (Number(customText) < TARGET_MIN || Number(customText) > TARGET_MAX) && (
            <span className="text-destructive">将按 {fmtChars(clamped)} 字执行（范围 1万~50万）</span>
          )}
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {budgetYuan != null
            ? `按招标预算约 ${(budgetYuan / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 万元估算(约 1 万元/页 · 每页约 600 字 · 下限约 80 页),推荐 ${fmtChars(suggested)} 字`
            : `本标书共 ${chapterCount} 章,推荐 ${fmtChars(Math.round((chapterCount * 2000) / 1000) * 1000)}~${fmtChars(suggestedTarget(chapterCount))} 字`}
          。此为目标参考:字数向技术标正文倾斜分配(商务标多为投标函/报价/偏离表等表单声明,篇幅短、不注水凑数),实际以内容质量为准,可拖动调整
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
