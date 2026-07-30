"use client"

import { ChevronRight, FolderOpen, Palette, Presentation, Sparkles, Upload } from "lucide-react"
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
  existingDeck,
  noProject,
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
  /** 本项目已生成过述标：卡上给「查看已生成」的入口（用户口径：菜单进来先看卡，已生成的给链接跳过去） */
  existingDeck?: { pages: number; onOpen: () => void }
  /** 还没有选中的标书：仍然停在这张卡（用户口径「没有我的项目的时候也是这个入口」），
   *  但不渲染计费按钮——没有标书可生成，亮出来点了只会失败。选标书走卡上那两个按钮。 */
  noProject?: boolean
}) {
  // 居中用子元素的 my-auto，而不是父级 items-center：flex 居中 + 溢出滚动的经典冲突——
  // 内容高于容器时 items-center 会把顶部推到滚动区之外，用户既看不到标题也滚不上去
  // （加了「已生成述标」横幅后变高即触发，生产实测）。my-auto 空间够时照样居中，不够时塌成 0 正常滚。
  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-4">
      <div className="my-auto w-full max-w-xl py-8">
        <div className="rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
            <Presentation className="size-7 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-foreground">一键生成述标大纲</h2>
          {existingDeck && (
            <button
              onClick={existingDeck.onOpen}
              className="mx-auto mt-3 flex w-full max-w-md items-center justify-between gap-2 rounded-xl border border-primary/30 gradient-brand-soft px-4 py-2.5 text-left"
            >
              <span className="text-sm font-medium text-primary">
                本项目已生成述标演示（{existingDeck.pages} 页）
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                查看 / 编辑
                <ChevronRight className="size-3.5" />
              </span>
            </button>
          )}
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            默认取当前项目已生成的标书内容（技术标 + 商务标），按评分点提炼为封面、项目理解、技术亮点、团队、业绩、服务承诺、报价、风险防控等演示页。
          </p>

          <DurationSection duration={duration} onDuration={onDuration} />
          <TemplateSection styleName={styleName} refPpt={refPpt} onOpenTemplates={onOpenTemplates} />
          <OtherBidSection />
          {noProject ? (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              还没有选中的标书——用上面的「从我的标书选择」挑一份，或「上传标书文件」传一份线下标书，
              选好后回到本页即可一键生成。
            </p>
          ) : (
            <GenerateAction
              cost={cost}
              balance={balance}
              balanceLoading={balanceLoading}
              generating={generating}
              onGenerate={onGenerate}
              regenerate={!!existingDeck}
            />
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            {existingDeck
              ? "重新生成会按当前时长与模板重出一份，覆盖现有述标，并再消耗一次积分"
              : "生成后可自由编辑幻灯与口播稿；导出 PPTX 另按导出口径消耗积分"}
          </p>
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

/** 述标别的标书：默认对当前项目述标，这里是两个次要入口。导出给 not-ready-card 复用——
 *  两屏上的同一组按钮各写一份会长得不一样（评审）。列表是入口页的默认视图，故 pick 不带 focus。 */
export function OtherBidSection() {
  const go = (focus?: "upload") => () => {
    window.location.href = focus ? `/present?view=entry&focus=${focus}` : "/present?view=entry"
  }
  const cls =
    "inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
      <button onClick={go()} className={cls}>
        <FolderOpen className="size-4 text-muted-foreground" />
        从我的标书选择
      </button>
      <button onClick={go("upload")} className={cls}>
        <Upload className="size-4 text-muted-foreground" />
        上传标书文件
      </button>
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
  regenerate,
}: {
  cost: number
  balance: number
  balanceLoading: boolean
  generating: boolean
  onGenerate: () => void
  /** 已有述标：按钮说「重新生成」——同样收费，写「生成」会被当成"打开已有的" */
  regenerate?: boolean
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
          actionLabel={`${regenerate ? "重新生成述标大纲" : "生成述标大纲"}（消耗 ${cost} 积分）`}
          onConfirm={onGenerate}
        />
      )}
    </div>
  )
}
