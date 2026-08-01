"use client"

import { useEffect, useState } from "react"
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

type Props = {
  projectId: string
  /** 用户确认值。三态：null/undefined=没表态；非空=选定；**空数组=明确不用分类** */
  confirmed: BidCategoryValue[] | null | undefined
  detected: DetectedCategory | null | undefined
  /** 服务端算好的**本次生效值**（确认值 ?? 判定值）。前端不再自己算一遍——
   *  「有效值解析只此一处」是服务端的约定，前端复算就是第二个实现，迟早两边漂。 */
  effective: BidCategoryValue[] | undefined
  /** 多包件招标：判定发生在选包之前，系统不判，文案改为让用户按所投包件选 */
  multiPackage?: boolean
  /** 改判生效时机的提示（审查页是「重跑审查后生效」，读标页下一步才用到，不必提示） */
  applyHint?: string
  onSaved?: () => void
}

/** 卡片说明文案。用户看到的每一句都必须与**实际生效的值**一致。
 *  confirmed 传的是**本地最新值**而非 props——保存后父组件不会重拉，用 props 的话文案会停在旧状态。 */
function hintText(p: Props, confirmed: BidCategoryValue[] | null | undefined,
                  primary: BidCategoryValue | null, off: boolean): string {
  const byDetection = confirmed == null && (p.detected?.value.length ?? 0) > 0
  if (off) return "已设为不使用分类，生成与审查不会带入类型知识。"
  if (byDetection) {
    const why = p.detected?.reason ? ` · ${p.detected.reason}` : ""
    return `系统判定：${BID_CATEGORY_LABEL[p.detected!.value[0]!]}${why} · 已按此生成，可修改`
  }
  if (primary) return "已按所选类型生成，可修改。"
  if (p.multiPackage) return "本项目为多包件招标，各包件类型可能不同，请选择所投包件的类型。"
  return "未能可靠判定本标类型，请选择——不同类型的必备章节与必查项差别很大。"
}

const btn = (on: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-foreground hover:border-primary/40"
  }`

export function CategoryCard(props: Props) {
  const { projectId, confirmed, detected, applyHint, onSaved } = props
  const effective = props.effective ?? []
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [primary, setPrimary] = useState<BidCategoryValue | null>(effective[0] ?? null)
  const [second, setSecond] = useState<BidCategoryValue | null>(effective[1] ?? null)
  // 确认值也必须进本地态：保存后父组件不会重新拉 info，只看 props 的话点了「不使用分类」
  // 界面纹丝不动——服务端已经存了、用户却以为没生效（生产实测）。
  const [saved, setSaved] = useState<BidCategoryValue[] | null | undefined>(confirmed)

  // 有效值来自父组件的 info：读标跑完、别处改判、切项目后 info 都会重新拉。**必须跟着同步**——
  // 只在挂载时取一次的话，卡片会永远停在那一刻的空状态，一边显示「未能可靠判定，请选择」，
  // 一边后台早已按判定值在生成。
  const fingerprint = `${projectId}:${effective.join(",")}:${confirmed === undefined ? "u" : JSON.stringify(confirmed)}`
  useEffect(() => {
    setPrimary(effective[0] ?? null)
    setSecond(effective[1] ?? null)
    setSaved(confirmed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  async function save(next: BidCategoryValue[] | null) {
    setState("saving")
    try {
      await setProjectCategory(projectId, next)
      setSaved(next)          // 乐观更新：父组件不重拉，本地不更新就等于点了没反应
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

  const off = Array.isArray(saved) && saved.length === 0
  return (
    <div className="mt-5 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">标书类型</h3>
        {state === "saving" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {state === "saved" && <span className="text-xs text-success">已保存</span>}
        {state === "error" && <span className="text-xs text-destructive">保存失败，请重试</span>}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hintText(props, saved, primary, off)}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {BID_CATEGORIES.map((v) => (
          <button key={v} onClick={() => pickPrimary(v)} className={btn(!off && primary === v)}>
            {!off && primary === v && <Check className="mr-1.5 inline size-3.5" />}
            {BID_CATEGORY_LABEL[v]}
          </button>
        ))}
        {/* 关掉分类：判定给出一个用户认为三类都不合适的类别时，他必须有办法叫停，否则每次重跑
            都被强加一次。再点一次回到「听系统的」（清成没表态）。 */}
        <button onClick={() => void save(off ? null : [])} className={btn(off)}>
          不使用分类
        </button>
      </div>

      {!off && primary && (
        <SecondaryPicker
          primary={primary}
          second={second}
          onPick={(v) => {
            setSecond(v)
            void save(v ? [primary, v] : [primary])
          }}
        />
      )}

      {applyHint && state === "saved" && <p className="mt-2 text-xs text-muted-foreground">{applyHint}</p>}
    </div>
  )
}

/** 次类别（混合标）。平台采购这类标 = 设备（货物）+ 实施运维（服务），硬选一个会丢掉另一半的
 *  必查项，漏一条就是废标。必备章节只按主类别（提纲结构只能有一套），必查项两类都查。 */
function SecondaryPicker({
  primary,
  second,
  onPick,
}: {
  primary: BidCategoryValue
  second: BidCategoryValue | null
  onPick: (v: BidCategoryValue | null) => void
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">本标还涉及（选填）</span>
      {BID_CATEGORIES.filter((v) => v !== primary).map((v) => (
        <button
          key={v}
          onClick={() => onPick(second === v ? null : v)}
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
  )
}
