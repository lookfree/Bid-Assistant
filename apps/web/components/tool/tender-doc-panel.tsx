"use client"

import { useEffect, useRef, useState } from "react"
import { FileText, MapPin } from "lucide-react"
import type { DocSectionGroup } from "@/lib/doc-sections"

/** 多文件读标（spec320）每份文件占用的章节区间（read 结果 docFiles，camelCase）。 */
export type DocFileRange = { name: string; secFrom: number; secTo: number }

/** 组 id（sec-N）尾部的章节号；无数字（如 sec-intro）返回 NaN。 */
function secNum(id: string): number {
  return Number(/(\d+)$/.exec(id)?.[1] ?? NaN)
}

/** 该分组是否落在文件的章节区间内；无数字 id 的组不属于任何文件（仅「全部」页签可见）。 */
function inFile(sec: DocSectionGroup, f: DocFileRange): boolean {
  const n = secNum(sec.id)
  return !Number.isNaN(n) && n >= f.secFrom && n <= f.secTo
}

/**
 * read/outline 共用的招标原文左栏：分组渲染 + 命中条款高亮定位。
 * sections 既可以是真实 read 结果 docSections 的分组，也可以是示例 tenderDoc（结构同构）。
 * files（多文件读标才有，>1 份时显示文件页签）：喂了多份文件时全文是合并渲染的，用户无法分辨
 * 各文件边界（生产反馈：5 份文件混在一起）——页签按文件过滤章节，挨个查看；右栏点定位跳到
 * 其它文件的条款时自动切到所属文件页签再滚动。
 */
export function TenderDocPanel({
  fileName,
  sections,
  activeSection,
  activeClauses,
  registerClauseRef,
  files,
}: {
  fileName: string
  sections: DocSectionGroup[]
  /** 弱高亮的所属分组 id */
  activeSection: string
  /** 精确高亮的条款 id（可多条） */
  activeClauses: string[]
  /** 登记条款段落 DOM，供右栏点击后 scrollIntoView 定位 */
  registerClauseRef: (id: string, el: HTMLParagraphElement | null) => void
  /** 多文件读标的文件区间（≤1 份不显示页签，行为与单文件一致） */
  files?: DocFileRange[]
}) {
  const [activeFile, setActiveFile] = useState(-1) // -1 = 全部
  const showTabs = (files?.length ?? 0) > 1
  const visible = showTabs && activeFile >= 0 ? sections.filter((s) => inFile(s, files![activeFile]!)) : sections

  // 本地条款 ref 表：页签过滤会卸载隐藏文件的段落，页面侧同步 scrollIntoView 会扑空——
  // 由下面的效果在（可能的）切页签渲染完成后兜底滚动。
  const localRefs = useRef<Record<string, HTMLParagraphElement | null>>({})

  // 定位目标在其它文件 → 自动切到所属文件页签（不打断用户已选的「全部」视图）
  useEffect(() => {
    if (!showTabs || activeFile < 0 || activeClauses.length === 0) return
    const n = secNum(activeClauses[0].replace(/-c\d+$/, ""))
    if (Number.isNaN(n)) return
    const f = files![activeFile]!
    if (n >= f.secFrom && n <= f.secTo) return
    const idx = files!.findIndex((fr) => n >= fr.secFrom && n <= fr.secTo)
    if (idx >= 0) setActiveFile(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClauses])

  // 滚动到命中条款：依赖含 activeFile——切页签后段落刚挂载，此时 ref 才拿得到
  useEffect(() => {
    if (activeClauses.length === 0) return
    localRefs.current[activeClauses[0]]?.scrollIntoView({ behavior: "smooth", block: "center" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClauses, activeFile])

  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <FileText className="size-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold text-foreground">{fileName}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {showTabs ? `原文 · ${files!.length} 份文件` : "原文"}
        </span>
      </header>
      {showTabs && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2">
          <button
            onClick={() => setActiveFile(-1)}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              activeFile === -1
                ? "gradient-brand text-white"
                : "border border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            全部
          </button>
          {files!.map((f, i) => (
            <button
              key={`${i}-${f.name}`}
              onClick={() => setActiveFile(i)}
              title={f.name}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                activeFile === i
                  ? "gradient-brand text-white"
                  : "border border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              <FileText className="size-3 shrink-0" />
              <span className="max-w-[9rem] truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* 真实项目读标未完成时不回落示例原文，给占位 */}
        {sections.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">读标完成后显示招标原文</p>
        )}
        {sections.length > 0 && visible.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">该文件无可解析条款</p>
        )}
        {visible.map((sec) => (
          <div
            key={sec.id}
            className={`rounded-xl px-3 py-3 transition-colors ${
              activeSection === sec.id ? "bg-primary/[0.04]" : ""
            } ${sec.id !== visible[0].id ? "mt-4" : ""}`}
          >
            <h3 className="text-sm font-bold text-foreground">{sec.title}</h3>
            <div className="mt-2 flex flex-col gap-1.5">
              {sec.paragraphs.map((clause) => {
                const hit = activeClauses.includes(clause.id)
                return (
                  <p
                    key={clause.id}
                    ref={(el) => {
                      localRefs.current[clause.id] = el
                      registerClauseRef(clause.id, el)
                    }}
                    className={`scroll-mt-16 rounded-lg px-2.5 py-1.5 text-[13px] leading-relaxed transition-colors ${
                      hit
                        ? "border-l-2 border-primary bg-primary/10 font-medium text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {hit && <MapPin className="mr-1 inline size-3.5 -translate-y-px text-primary" />}
                    {clause.text}
                  </p>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
