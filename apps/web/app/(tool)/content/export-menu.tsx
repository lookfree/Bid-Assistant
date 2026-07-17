"use client"

import { Briefcase, CheckCircle2, FileText, FileType2, FileText as FileDoc, Layers } from "lucide-react"
import { CreditEstimate } from "@/components/credit-estimate"

export type BidType = "tech" | "business" | "full"
export type ExportFormat = "word" | "pdf"

const exportScopes: { id: BidType; name: string; desc: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术文件", desc: "仅导出技术标全部章节", icon: FileText },
  { id: "business", name: "商务文件", desc: "仅导出商务标全部章节", icon: Briefcase },
  { id: "full", name: "标书全文", desc: "技术标 + 商务标合并导出", icon: Layers },
]

/** 导出菜单弹层：选择范围 / 格式 + 积分预估确认。
 * pdfUnavailable：该项目已跑过导出且本次未产出 pdf（agent 侧 soffice 转换失败），PDF 选项置灰不可选。 */
export function ExportMenu({
  scope,
  format,
  cost,
  balance,
  pdfUnavailable = false,
  onScope,
  onFormat,
  onConfirm,
  onClose,
}: {
  scope: BidType
  format: ExportFormat
  cost: number
  balance: number
  pdfUnavailable?: boolean
  onScope: (s: BidType) => void
  onFormat: (f: ExportFormat) => void
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <>
      <button aria-label="关闭导出菜单" onClick={onClose} className="fixed inset-0 z-40 cursor-default" />
      <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-2xl border border-border bg-card p-3 shadow-lg">
        <p className="px-1 pb-2 text-xs font-semibold text-foreground">选择导出范围</p>
        <div className="flex flex-col gap-1">
          {exportScopes.map((s) => {
            const Icon = s.icon
            const isActive = scope === s.id
            return (
              <button
                key={s.id}
                onClick={() => onScope(s.id)}
                className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                  isActive ? "border-primary/40 gradient-brand-soft" : "border-border hover:bg-muted"
                }`}
              >
                <Icon className={`mt-0.5 size-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-foreground">{s.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{s.desc}</span>
                </span>
                {isActive && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>

        <p className="px-1 pb-2 pt-3 text-xs font-semibold text-foreground">选择导出格式</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onFormat("word")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
              format === "word" ? "border-primary/40 gradient-brand-soft text-foreground" : "border-border bg-background text-foreground hover:bg-muted"
            }`}
          >
            <FileDoc className="size-4 text-primary" />
            Word
          </button>
          <button
            onClick={() => onFormat("pdf")}
            disabled={pdfUnavailable}
            title={pdfUnavailable ? "PDF 生成失败，仅提供 Word" : undefined}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              format === "pdf" ? "border-primary/40 gradient-brand-soft text-foreground" : "border-border bg-background text-foreground hover:bg-muted"
            }`}
          >
            <FileType2 className="size-4 text-destructive" />
            PDF
          </button>
        </div>
        {/* TOC 用 Word 域实现，需 Word/WPS 打开后手动刷新一次页码 */}
        <p className="px-1 pt-1.5 text-[10px] text-muted-foreground">Word 打开后按 F9 可更新目录页码</p>
        <p className="px-1 pt-1.5 text-[10px] text-muted-foreground">本内容由 AI 辅助生成，仅供参考，请人工复核后使用</p>

        {/* 积分预估 */}
        <div className="mt-3">
          <CreditEstimate cost={cost} balance={balance} showSupportable={false} actionLabel="确认导出" onConfirm={onConfirm} />
        </div>
      </div>
    </>
  )
}
