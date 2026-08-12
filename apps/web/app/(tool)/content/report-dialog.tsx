"use client"

import Link from "next/link"
import { tenderLocateHref } from "@/lib/tender-locate"
import { AlertTriangle, ArrowRight, CheckCircle2, FileText, FileType2, FileText as FileDoc, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { type CheckItem, type HealthReport } from "@/lib/risk-derive"
import { checkToneClasses } from "./check-dialogs"
import { type BidType } from "./export-menu"

type ExportFormat = "word" | "pdf"

/** 报告头部：健康分 + 三档计数 + 关闭。 */
function ReportHeader({ report, onClose }: { report: HealthReport; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border p-5">
      <div className="flex items-center gap-4">
        <div className="flex size-16 shrink-0 flex-col items-center justify-center rounded-2xl gradient-brand-soft">
          <span className="text-2xl font-bold leading-none text-primary">{report.score}</span>
          <span className="mt-0.5 text-[10px] text-muted-foreground">健康分</span>
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">废标体检报告</h2>
          <p className="mt-1 text-xs text-muted-foreground">针对当前这份标书草稿的投递前自检</p>
          <div className="mt-2 flex items-center gap-4 text-xs">
            <span className="inline-flex items-center gap-1 text-destructive">
              <ShieldAlert className="size-3.5" />
              高风险 {report.high}
            </span>
            <span className="inline-flex items-center gap-1 text-warning-foreground">
              <AlertTriangle className="size-3.5" />
              中风险 {report.mid}
            </span>
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="size-3.5" />
              已通过 {report.passed}
            </span>
          </div>
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="关闭报告"
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}

/** 单条风险卡：整改建议 + 定位到对应章节。整改建议可见性由服务端决定（评审修正:此前本弹层
 *  完全无锁,与摘要弹层一锁一不锁自相矛盾）——advice 被裁剪时渲染统一解锁引导。 */
function RiskCard({
  item,
  onGoto,
  locatable,
}: {
  item: CheckItem
  onGoto: (tab: BidType, id: string, anchor: string) => void
  /** 这条问题是否真的指向某一章。false = 全文性要求（装订、密封、递交时间…），无章可跳。 */
  locatable: boolean
}) {
  const tc = checkToneClasses[item.tone]
  const tenderHref = tenderLocateHref(item.chapter)
  return (
    <div className={`rounded-xl border ${tc.border} p-3.5`}>
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tc.badge}`}>{item.level}</span>
        <span className="text-sm font-medium text-foreground">{item.title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-foreground">{item.advice}</p>
      <div className="mt-3 flex items-center justify-between">
        {/* 招标出处点得动：跳读标页把那一条招标要求滚出来并高亮。用户要核对的是「招标到底
            怎么要求的」，这行字以前只能看不能点，只好自己回读标页翻。
            出处太短（「技术」这种）时 tenderLocateHref 给 null，保持灰字不假装能跳。 */}
        {tenderHref ? (
          <a
            href={tenderHref}
            title="在招标原文中查看这一条要求"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            <FileText className="size-3.5" />
            {item.chapter} →
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <FileText className="size-3.5" />
            {item.chapter}
          </span>
        )}
        {/* 无章可跳时不给按钮。此前一律渲染，点下去 list.find(...) ?? list[0] 会**跳到第一章**，
            看起来像定位成功了——实测线上一份报告 63 条里有 10 条如此（都是「装订/密封/递交时间/
            报价有效期」这类全文性要求，模型没有章节可指，就填了个不存在的 b0）。
            假装定位比不给定位更糟：用户会以为问题出在第一章。 */}
        {locatable ? (
          <button
            onClick={() => onGoto(item.targetTab, item.targetId, item.anchorText)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 gradient-brand-soft px-3 py-1.5 text-xs font-semibold text-primary transition-opacity hover:opacity-90"
          >
            定位到本章修改
            <ArrowRight className="size-3.5" />
          </button>
        ) : (
          <span className="text-[11px] text-muted-foreground">全文性要求，不限于某一章</span>
        )}
      </div>
    </div>
  )
}

/** 报告底部：导出体检报告 / 导出标书文件 / 免责说明。 */
function ReportFooter({
  exportStatus,
  onExportReport,
  onExportBid,
}: {
  exportStatus: string
  onExportReport: (format: ExportFormat) => void
  onExportBid: (format: ExportFormat) => void
}) {
  return (
    <div className="border-t border-border bg-muted/40 px-5 py-3.5">
      {exportStatus && <p className="mb-2.5 text-[11px] font-medium text-primary">{exportStatus}</p>}
      <div className="flex flex-col gap-3">
        {/* 导出体检报告 */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs font-medium text-foreground">导出体检报告</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => onExportReport("word")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileDoc className="size-3.5 text-primary" />
              导出 Word
            </button>
            <button
              onClick={() => onExportReport("pdf")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileType2 className="size-3.5 text-destructive" />
              导出 PDF
            </button>
          </div>
        </div>

        {/* 导出标书文件（已查看风险后软放行导出） */}
        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs font-medium text-foreground">导出标书文件</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => onExportBid("word")}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <FileDoc className="size-3.5" />
              导出 Word
            </button>
            <button
              onClick={() => onExportBid("pdf")}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <FileType2 className="size-3.5" />
              导出 PDF
            </button>
          </div>
        </div>

        <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          体检仅供投递前自检，不替代正式标书审查。如需对任意标书做完整合规比对，请使用
          <Link href="/risk" className="mx-0.5 font-medium text-primary hover:underline">
            标书审查
          </Link>
          工具。
        </p>
      </div>
    </div>
  )
}

/** 就地完整体检报告弹层（针对当前这份标书草稿），区别于独立的 /risk。 */
export function ReportDialog({
  report,
  exportStatus,
  chapterIds,
  onClose,
  onGoto,
  onExportReport,
  onExportBid,
}: {
  report: HealthReport
  exportStatus: string
  /** 当前标书真实存在的章节 id。用来判断某条问题到底跳不跳得过去。 */
  chapterIds: ReadonlySet<string>
  onClose: () => void
  onGoto: (tab: BidType, id: string, anchor: string) => void
  onExportReport: (format: ExportFormat) => void
  onExportBid: (format: ExportFormat) => void
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <ReportHeader report={report} onClose={onClose} />

        {/* 正文：逐条风险 + 已通过项 */}
        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-xs font-semibold text-foreground">待处理风险项</p>
          <div className="mt-2 flex flex-col gap-3">
            {report.items.map((it, i) => (
              <RiskCard key={i} item={it} onGoto={onGoto} locatable={chapterIds.has(it.targetId)} />
            ))}
          </div>

          <p className="mt-5 text-xs font-semibold text-foreground">已通过项</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {report.passedItems.map((p, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg bg-success/5 px-3 py-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span className="text-xs text-foreground">{p}</span>
              </div>
            ))}
          </div>
        </div>

        <ReportFooter exportStatus={exportStatus} onExportReport={onExportReport} onExportBid={onExportBid} />
      </div>
    </div>
  )
}
