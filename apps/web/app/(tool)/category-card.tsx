"use client"

import { useState } from "react"
import { Check, Loader2 } from "lucide-react"
import {
  BID_CATEGORIES,
  BID_CATEGORY_LABEL,
  setProjectCategory,
  type BidCategoryValue,
  type DetectedCategory,
} from "@/lib/project"

/* 标书分类卡（spec334）：读标页在选包卡下方渲染；无招标文件的线下标书没有读标页，渲染在审查页。
   文案必须诚实——系统判定是**默认生效**的，所以显示「已按此生成」而不是「请选择」；
   写成「请选择」却在背后已经用上了，等于骗用户。 */
export function CategoryCard({
  projectId,
  confirmed,
  detected,
  multiPackage = false,
  applyHint,
  onSaved,
}: {
  projectId: string
  /** 用户确认值。三态：null/undefined=没表态；非空=选定；**空数组=明确不用分类** */
  confirmed: BidCategoryValue[] | null | undefined
  detected: DetectedCategory | null | undefined
  /** 多包件招标：判定发生在选包之前，系统不判，文案改为让用户按所投包件选 */
  multiPackage?: boolean
  /** 改判生效时机的提示（审查页是「重跑审查后生效」，读标页下一步才用到，不必提示） */
  applyHint?: string
  onSaved?: () => void
}) {
  const effective = confirmed ?? detected?.value ?? []
  const [primary, setPrimary] = useState<BidCategoryValue | null>(effective[0] ?? null)
  const [second, setSecond] = useState<BidCategoryValue | null>(effective[1] ?? null)
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle")

  // 用户还没表态、但系统判过 ⇒ 那个判定已经在生效了，必须说清楚
  const byDetection = confirmed == null && (detected?.value.length ?? 0) > 0
  const off = Array.isArray(confirmed) && confirmed.length === 0

  async function save(next: BidCategoryValue[] | null) {
    setState("saving")
    try {
      await setProjectCategory(projectId, next)
      setState("saved")
      onSaved?.()
    } catch {
      setState("error")
    }
  }

  function pickPrimary(v: BidCategoryValue) {
    const nextSecond = second === v ? null : second // 主次不能是同一类
    setPrimary(v)
    setSecond(nextSecond)
    void save(nextSecond ? [v, nextSecond] : [v])
  }

  function pickSecond(v: BidCategoryValue | null) {
    setSecond(v)
    if (primary) void save(v ? [primary, v] : [primary])
  }

  return (
    <div className="mt-5 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">标书类型</h3>
        {state === "saving" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {state === "saved" && <span className="text-xs text-success">已保存</span>}
        {state === "error" && <span className="text-xs text-destructive">保存失败，请重试</span>}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {multiPackage
          ? "本项目为多包件招标，各包件类型可能不同，请选择所投包件的类型。"
          : byDetection
            ? `系统判定：${BID_CATEGORY_LABEL[detected!.value[0]!]}${detected?.reason ? ` · ${detected.reason}` : ""} · 已按此生成，可修改`
            : off
              ? "已设为不使用分类，生成与审查不会带入类型知识。"
              : primary
                ? "已按所选类型生成，可修改。"
                : "未能可靠判定本标类型，请选择——不同类型的必备章节与必查项差别很大。"}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {BID_CATEGORIES.map((v) => (
          <button
            key={v}
            onClick={() => pickPrimary(v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              primary === v
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border text-foreground hover:border-primary/40"
            }`}
          >
            {primary === v && <Check className="size-3.5" />}
            {BID_CATEGORY_LABEL[v]}
          </button>
        ))}
      </div>

      {primary && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* 混合标（如平台采购=设备+实施+运维）：硬选一个会丢掉另一半的必查项，漏一条就是废标。
              必备章节只按主类别（提纲结构只能有一套），必查项两类都查。 */}
          <span className="text-xs text-muted-foreground">本标还涉及（选填）</span>
          {BID_CATEGORIES.filter((v) => v !== primary).map((v) => (
            <button
              key={v}
              onClick={() => pickSecond(second === v ? null : v)}
              className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                second === v
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              {BID_CATEGORY_LABEL[v]}
            </button>
          ))}
        </div>
      )}

      {applyHint && state === "saved" && (
        <p className="mt-2 text-xs text-muted-foreground">{applyHint}</p>
      )}
    </div>
  )
}
