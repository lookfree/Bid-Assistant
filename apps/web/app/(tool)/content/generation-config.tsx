"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Sparkles } from "lucide-react"
import { fmtChars } from "@/lib/doc-stats"
import { densityForFormat } from "@/lib/page-estimate"
import { useOtherStepResult } from "@/lib/use-step"
import type { ProjectInfo } from "@/lib/project"
import type { PackageInfo } from "@/lib/bid-types"
import { FormatPanel } from "./format-panel"
import {
  DEFAULT_FORMAT,
  FONT_OPTIONS,
  SIZE_OPTIONS,
  TARGET_MAX,
  TARGET_MIN,
  budgetForSizing,
  loadGenConfig,
  storedTargetFor,
  parseBudgetYuan,
  sanitizeFormat,
  saveGenConfig,
  suggestedTarget,
  targetPagesFor,
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
  const { data: readMeta } = useOtherStepResult<{ projectMeta?: { budget?: string }; packages?: PackageInfo[] }>(projectId, info, "read")
  // 多包件招标一次只投一个包：字数按「选中那个包」的限价估算，而非全招标总预算（各包之和）。
  // budget 与 fromPackage 同源于 budgetForSizing（文案与取值绝不各判一次，防漂移）。
  const selectedPkgId = info?.project.selectedPackage?.id ?? null
  const { budget, fromPackage: usingPkgBudget } = budgetForSizing(
    readMeta?.projectMeta?.budget,
    readMeta?.packages,
    selectedPkgId,
  )
  const budgetYuan = parseBudgetYuan(budget)
  const [fmt, setFmt] = useState<DocFormat>(() => sanitizeFormat(loadGenConfig().format ?? {}))
  const [fmtOpen, setFmtOpen] = useState(false)
  // 派生估算一律吃**消毒后**的格式（评审 F6:边距输入框敲到一半的"25"会把版面算成负宽、
  // 推荐字数被垃圾值改写并可能被确认提交）;输入框本身仍绑原始 fmt,不与用户打字互搏
  const fmtView = useMemo(() => sanitizeFormat(fmt), [fmt])
  // 推荐字数随排版走（页数目标不变,每页容量随字号/行距/边距变）
  const suggested = suggestedTarget(chapterCount, budget, fmtView)
  // 只在挂载时读一次，且**仅取本项目**存过的值：目标字数由该项目/包件的预算规模决定，
  // 跨项目复用会让新项目沿用上个大项目的字数（滑杆 25.5万 vs 说明「推荐 5.9万」自相矛盾）。
  const savedTarget = useRef<number | undefined>(storedTargetFor(projectId)).current
  const [target, setTarget] = useState<number>(() => savedTarget ?? suggested)
  const touched = useRef(false) // 用户是否手动改过——避免预算异步到达后覆盖用户已调的值
  // 预算异步到达后，用户没存过偏好、也没手动改过 → 用预算推荐值刷新初始（否则停在章数推荐）。
  useEffect(() => {
    if (savedTarget == null && !touched.current) setTarget(suggested)
  }, [suggested, savedTarget])
  const [custom, setCustom] = useState(false)
  // 自定义输入用「原始字符串」状态：受控值若绑夹位后的数字,逐位输入会被强改（审查实测 15000 打成 100005）
  const [customText, setCustomText] = useState("")

  const raw = custom ? Number(customText) : target
  const clamped = Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(raw) || TARGET_MIN))
  function confirm() {
    const clean = sanitizeFormat(fmt) // 确认时消毒（夹边距/回落非法枚举）,坏值绝不进 localStorage
    saveGenConfig({ targetChars: clamped, format: clean }, projectId) // 字数记到本项目名下
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
            约 <b className="text-primary">{fmtChars(clamped)}字</b> · {targetPagesFor(clamped, fmtView)}页
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
            ? `按${usingPkgBudget ? "本包" : "招标"}预算约 ${(budgetYuan / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 万元估算(约 1 万元/页 · 按当前排版每页约 ${densityForFormat(fmtView)} 字 · 下限约 80 页),推荐 ${fmtChars(suggested)} 字`
            : `本标书共 ${chapterCount} 章,推荐 ${fmtChars(Math.round((chapterCount * 2000) / 1000) * 1000)}~${fmtChars(suggestedTarget(chapterCount))} 字`}
          。此为目标参考:字数向技术标正文倾斜分配(商务标多为投标函/报价/偏离表等表单声明,篇幅短、不注水凑数),实际以内容质量为准,可拖动调整
        </p>

        <button onClick={() => setFmtOpen((v) => !v)} className="mt-4 text-xs font-medium text-primary hover:underline">
          {fmtOpen ? "▾ 输出格式（导出 Word 生效）" : "▸ 输出格式（导出 Word 生效,默认:宋体小四/1.5倍行距/标准页边距）"}
        </button>
        {fmtOpen && (
          <FormatPanel fmt={fmt} setF={setF} setMargin={setMargin} onReset={() => setFmt({ ...DEFAULT_FORMAT })} />
        )}

        {/* 说明一行、按钮一行：阶梯计费文案较长,与按钮同排会把按钮挤成竖排单字。
            whitespace-nowrap 兜底,窄屏下按钮文字也不再逐字折行。 */}
        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
          <span className="text-xs leading-relaxed text-muted-foreground">{costText}</span>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="shrink-0 whitespace-nowrap rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted">
              取消
            </button>
            <button
              onClick={confirm}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl gradient-brand px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
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
