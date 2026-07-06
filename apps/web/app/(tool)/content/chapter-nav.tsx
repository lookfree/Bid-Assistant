"use client"

import { AlertTriangle, CheckCircle2 } from "lucide-react"

export type Chapter = {
  id: string
  no: string
  title: string
  /** 是否能在招标文件中索引到来源；false 表示提纲新增、正文缺失需补写 */
  sourced: boolean
  /** 已生成的正文 HTML；空字符串表示尚未生成（缺失） */
  html: string
}

/** 左栏：标书目录（全文模式下按技术标 / 商务标分组展示）。 */
export function ChapterNav({
  groups,
  activeId,
  generatedCount,
  total,
  onSelect,
}: {
  groups: { label: string; items: Chapter[] }[]
  activeId: string
  generatedCount: number
  total: number
  onSelect: (id: string) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold text-foreground">标书目录</span>
        <span className="text-xs text-muted-foreground">
          {generatedCount}/{total}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map((grp) => (
          <div key={grp.label || "single"} className="mb-1">
            {grp.label && (
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {grp.label}
              </div>
            )}
            {grp.items.map((ch) => {
              const isActive = ch.id === activeId
              const isMissing = !ch.html.trim()
              return (
                <button
                  key={ch.id}
                  onClick={() => onSelect(ch.id)}
                  className={`mb-1 flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                    isActive ? "gradient-brand-soft border border-primary/30" : "hover:bg-muted"
                  }`}
                >
                  <span className="mt-0.5 shrink-0">
                    {isMissing ? (
                      <AlertTriangle className="size-4 text-warning-foreground" />
                    ) : (
                      <CheckCircle2 className="size-4 text-success" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-medium text-primary">{ch.no}</span>
                    <span className="block truncate text-[13px] font-medium text-foreground">{ch.title}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {!ch.sourced && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          新增
                        </span>
                      )}
                      {isMissing && (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning-foreground">
                          待生成
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
