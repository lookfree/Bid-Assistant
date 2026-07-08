"use client"

import { ChevronRight, Palette, Presentation, Sparkles } from "lucide-react"
import { CreditEstimate } from "@/components/credit-estimate"

export type Duration = 10 | 15 | 20
export const DURATIONS: Duration[] = [10, 15, 20]

/* ============== 空状态：生成大纲（计费步显式入口，明示消耗后由用户确认触发） ============== */
export function EmptyState({
  duration,
  onDuration,
  cost,
  balance,
  balanceLoading,
  generating,
  onGenerate,
  styleName,
  refPpt,
  onOpenTemplates,
}: {
  duration: Duration
  onDuration: (d: Duration) => void
  /** 述标生成单次消耗积分（后端实时口径，页面传入） */
  cost: number
  balance: number
  /** 余额加载中：不渲染依赖余额的预估确认条（防按 balance=0 误判余额不足） */
  balanceLoading: boolean
  generating: boolean
  onGenerate: () => void
  styleName: string
  refPpt: string | null
  onOpenTemplates: () => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-xl py-8">
        <div className="rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
            <Presentation className="size-7 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-foreground">一键生成述标大纲</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            默认取当前项目已生成的标书内容（技术标 + 商务标），按评分点提炼为封面、项目理解、技术亮点、团队、业绩、服务承诺、报价、风险防控等演示页。
          </p>

          <DurationSection duration={duration} onDuration={onDuration} />
          <TemplateSection styleName={styleName} refPpt={refPpt} onOpenTemplates={onOpenTemplates} />
          <GenerateAction cost={cost} balance={balance} balanceLoading={balanceLoading} generating={generating} onGenerate={onGenerate} />
          <p className="mt-3 text-[11px] text-muted-foreground">生成后可自由编辑幻灯与口播稿；导出 PPTX 另按导出口径消耗积分</p>
        </div>
      </div>
    </div>
  )
}

/* 时长选择 */
function DurationSection({ duration, onDuration }: { duration: Duration; onDuration: (d: Duration) => void }) {
  return (
    <div className="mt-5">
      <p className="text-xs font-medium text-muted-foreground">选择述标时长</p>
      <div className="mt-2 inline-flex items-center gap-1 rounded-xl border border-border bg-background p-1">
        {DURATIONS.map((d) => (
          <button
            key={d}
            onClick={() => onDuration(d)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              duration === d ? "gradient-brand text-white" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {d} 分钟
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">AI 将据此调整页数与每页内容密度</p>
    </div>
  )
}

/* 模板与参考入口 */
function TemplateSection({
  styleName,
  refPpt,
  onOpenTemplates,
}: {
  styleName: string
  refPpt: string | null
  onOpenTemplates: () => void
}) {
  return (
    <div className="mt-5">
      <p className="text-xs font-medium text-muted-foreground">演示模板与参考</p>
      <button
        onClick={onOpenTemplates}
        className="mx-auto mt-2 inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
      >
        <Palette className="size-4 text-primary" />
        模板：{styleName}
        {refPpt && <span className="text-xs text-muted-foreground">· 参考 {refPpt}</span>}
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
      <p className="mt-2 text-[11px] text-muted-foreground">
        可套用企业自有模板或参考历史述标 PPT（会员专享）
      </p>
    </div>
  )
}

/* 积分预估 + 生成（余额加载中禁用，防按 0 余额误判） */
function GenerateAction({
  cost,
  balance,
  balanceLoading,
  generating,
  onGenerate,
}: {
  cost: number
  balance: number
  balanceLoading: boolean
  generating: boolean
  onGenerate: () => void
}) {
  return (
    <div className="mt-6">
      {generating ? (
        <div className="inline-flex items-center gap-2 rounded-xl gradient-brand px-6 py-3 text-sm font-semibold text-white">
          <Sparkles className="size-4 animate-pulse" />
          正在生成述标大纲…
        </div>
      ) : balanceLoading ? (
        <div className="inline-flex items-center gap-2 rounded-xl border border-border bg-muted px-6 py-3 text-sm font-semibold text-muted-foreground">
          余额加载中…
        </div>
      ) : (
        <CreditEstimate
          cost={cost}
          balance={balance}
          unitLabel="次"
          showSupportable={false}
          actionLabel={`生成述标大纲（消耗 ${cost} 积分）`}
          onConfirm={onGenerate}
        />
      )}
    </div>
  )
}
