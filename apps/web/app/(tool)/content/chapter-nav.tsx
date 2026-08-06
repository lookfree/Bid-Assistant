"use client"

import { useMemo, useRef } from "react"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { countChars, fmtChars } from "@/lib/doc-stats"
import { estimateChapterLines, pagesFromLines, type ChapterLines } from "@/lib/page-estimate"
import { genConfigFingerprint, loadGenConfig, sanitizeFormat } from "@/lib/generation-config"

export type Chapter = {
  id: string
  no: string
  title: string
  /** 是否能在招标文件中索引到来源；false 表示提纲新增、正文缺失需补写 */
  sourced: boolean
  /** 已生成的正文 HTML；空字符串表示尚未生成（缺失） */
  html: string
}

/** 按章缓存字数：父组件每次渲染都会重建 groups 数组（useMemo 依赖失效），但未改动章节的
 *  html 字符串引用不变——用 id→{html,chars} 缓存把逐章正则统计降为引用比较，避免 MB 级
 *  文档每次渲染全量重算（read-onchunk O(n²) 同款教训）。 */
function useChapterChars(): (ch: Chapter) => number {
  const cache = useRef(new Map<string, { html: string; chars: number }>())
  return (ch: Chapter) => {
    const hit = cache.current.get(ch.id)
    if (hit && hit.html === ch.html) return hit.chars
    const chars = countChars(ch.html)
    cache.current.set(ch.id, { html: ch.html, chars })
    return chars
  }
}

/** 左栏：标书目录（全文模式下按技术标 / 商务标分组展示）。 */
export function ChapterNav({
  groups,
  activeId,
  generatedCount,
  total,
  onSelect,
  fullDoc,
}: {
  groups: { label: string; items: Chapter[] }[]
  activeId: string
  generatedCount: number
  total: number
  onSelect: (id: string) => void
  /** 全文视图才计封面/目录/签章固定页——技术标/商务标分栏是局部视图,带上会凭空多 2+ 页（评审 F9） */
  fullDoc?: boolean
}) {
  const charsOf = useChapterChars()
  const totalChars = groups.reduce((sum, g) => sum + g.items.reduce((s, c) => s + charsOf(c), 0), 0)
  // 页数按排版感知结构估算（表格/标题按行高计费）；逐章行数走同款引用缓存,格式取用户存的导出偏好。
  // 缓存条目带格式指纹（评审 F5/F14）：格式改过的章按需重算,未变的章引用命中零成本
  const fmtRaw = genConfigFingerprint()
  const fmt = useMemo(() => sanitizeFormat(loadGenConfig().format ?? {}), [fmtRaw])
  const linesCache = useRef(new Map<string, { html: string; fmtRaw: string; stat: ChapterLines }>())
  const totalPages = pagesFromLines(
    groups.flatMap((g) =>
      g.items.map((c) => {
        const hit = linesCache.current.get(c.id)
        if (hit && hit.html === c.html && hit.fmtRaw === fmtRaw) return hit.stat
        const stat = estimateChapterLines(c.html, fmt)
        linesCache.current.set(c.id, { html: c.html, fmtRaw, stat })
        return stat
      }),
    ),
    fmt,
    { fixedSections: fullDoc === true },
  )
  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">标书目录</span>
          <span className="text-xs text-muted-foreground">
            {generatedCount}/{total}
          </span>
        </div>
        {totalChars > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            全文约 {fmtChars(totalChars)} 字 · 约 {totalPages} 页（按当前排版估算）
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map((grp) => (
          <div key={grp.label || "single"} className="mb-1">
            {grp.label && (
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {grp.label}
              </div>
            )}
            {grp.items.map((ch) => (
              <ChapterRow key={ch.id} ch={ch} chars={charsOf(ch)} isActive={ch.id === activeId} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

/** 目录单行：状态图标 + 章号/标题 + 字数与状态徽标。 */
function ChapterRow({
  ch,
  chars,
  isActive,
  onSelect,
}: {
  ch: Chapter
  chars: number
  isActive: boolean
  onSelect: (id: string) => void
}) {
  const isMissing = !ch.html.trim()
  return (
    <button
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
        <span className="block truncate text-[13px] font-medium text-foreground" title={ch.title}>{ch.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {!isMissing && <span className="text-[10px] text-muted-foreground">约 {fmtChars(chars)} 字</span>}
          {!ch.sourced && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">新增</span>
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
}
