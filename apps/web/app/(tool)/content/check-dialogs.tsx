"use client"

import Link from "next/link"
import { ArrowRight, Lock, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { CreditEstimate } from "@/components/credit-estimate"
import { type CheckItem, type HealthReport } from "@/lib/risk-derive"

export const checkToneClasses: Record<CheckItem["tone"], { badge: string; border: string }> = {
  destructive: { badge: "bg-destructive/10 text-destructive", border: "border-destructive/30" },
  warning: { badge: "bg-warning/15 text-warning-foreground", border: "border-warning/30" },
}

/** 体检摘要弹层里的单条风险（整改建议非会员模糊处理）。 */
function SummaryItem({ item, isMember }: { item: CheckItem; isMember: boolean }) {
  const tc = checkToneClasses[item.tone]
  return (
    <div className={`rounded-xl border ${tc.border} p-2.5`}>
      <div className="flex items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tc.badge}`}>{item.level}</span>
        <span className="truncate text-[12px] font-medium text-foreground">{item.title}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{item.chapter}</p>
      {isMember ? (
        <p className="mt-1 text-[11px] leading-relaxed text-foreground">{item.advice}</p>
      ) : (
        <div className="relative mt-1">
          <p className="select-none text-[11px] leading-relaxed text-foreground blur-[3px]">{item.advice}</p>
          <div className="absolute inset-0 flex items-center justify-center">
            <Link
              href="/membership"
              className="inline-flex items-center gap-1 rounded-full bg-card/80 px-2 py-0.5 text-[10px] font-medium text-primary transition-opacity hover:opacity-80"
            >
              <Lock className="size-3" />
              解锁查看完整整改建议
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

/** 体检结果摘要弹层（锚定在「一键废标体检」按钮上方）。 */
export function CheckSummary({
  report,
  isMember,
  onClose,
  onOpenReport,
}: {
  report: HealthReport
  isMember: boolean
  onClose: () => void
  onOpenReport: () => void
}) {
  return (
    <>
      <button aria-label="关闭体检摘要" onClick={onClose} className="fixed inset-0 z-40 cursor-default" />
      <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-2xl border border-border bg-card p-4 shadow-lg">
        {/* 健康分 + 计数 */}
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <div className="flex size-12 shrink-0 flex-col items-center justify-center rounded-xl gradient-brand-soft">
            <span className="text-lg font-bold leading-none text-primary">{report.score}</span>
            <span className="text-[9px] text-muted-foreground">健康分</span>
          </div>
          <div className="flex flex-1 items-center justify-between text-center text-xs">
            <span className="flex flex-col">
              <span className="text-sm font-bold text-destructive">{report.high}</span>
              <span className="text-muted-foreground">高风险</span>
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-bold text-warning-foreground">{report.mid}</span>
              <span className="text-muted-foreground">中风险</span>
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-bold text-success">{report.passed}</span>
              <span className="text-muted-foreground">已通过</span>
            </span>
          </div>
        </div>

        {/* 逐条风险 */}
        <div className="mt-3 flex max-h-56 flex-col gap-2 overflow-y-auto">
          {report.items.map((it, i) => (
            <SummaryItem key={i} item={it} isMember={isMember} />
          ))}
        </div>

        <button
          onClick={onOpenReport}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          查看完整体检报告
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </>
  )
}

/** 体检计费确认弹层：体检（review 步）是计费步，真跑前显式确认消耗；不再任何路径静默触发。 */
export function CheckConfirm({
  cost,
  balance,
  note,
  skip,
  onConfirm,
  onClose,
}: {
  cost: number
  balance: number
  /** 补充说明（如从导出路径进入时提示后续还需完成的步骤） */
  note?: string
  /** 跳过体检直接导出（仅当导出闸允许时提供） */
  skip?: { label: string; onSkip: () => void }
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label="废标体检计费确认" className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <button
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        <div className="flex size-11 items-center justify-center rounded-xl gradient-brand-soft text-primary">
          <ShieldCheck className="size-5" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-foreground">一键废标体检</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          AI 将逐条比对招标要求与标书内容，生成废标体检报告。本次体检消耗 {cost} 积分。
        </p>
        {note && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>}
        <div className="mt-4">
          <CreditEstimate cost={cost} balance={balance} showSupportable={false} actionLabel="确认体检" onConfirm={onConfirm} />
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {skip && (
            <button
              onClick={skip.onSkip}
              className="inline-flex items-center justify-center rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {skip.label}
            </button>
          )}
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/** 导出前高风险二次确认弹层。 */
export function ExportConfirm({
  report,
  onViewReport,
  onExportAnyway,
  onClose,
}: {
  report: HealthReport
  onViewReport: () => void
  onExportAnyway: () => void
  onClose: () => void
}) {
  const first = report.items.find((it) => it.tone === "destructive")
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="导出前发现废标高风险"
        className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <ShieldAlert className="size-5" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-foreground">导出前发现废标高风险</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          本次体检发现 {report.high} 项高风险{first ? `（如「${first.title}」）` : ""}
          ，可能导致直接废标。建议先处理风险再导出。
        </p>
        <div className="mt-5 flex flex-col gap-2.5">
          <button
            onClick={onViewReport}
            className="inline-flex items-center justify-center gap-2 rounded-xl gradient-brand px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            <ShieldCheck className="size-4" />
            查看并处理风险
          </button>
          <button
            onClick={onExportAnyway}
            className="inline-flex items-center justify-center rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            仍要导出
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            取消（留在编辑）
          </button>
        </div>
      </div>
    </div>
  )
}
