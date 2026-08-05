"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, FileText, MapPin, Search, X } from "lucide-react"
import { searchDocSections, splitByQuery, type DocSectionGroup } from "@/lib/doc-sections"

/** 多文件读标（spec320）每份文件占用的章节区间（read 结果 docFiles，camelCase）。 */
export type DocFileRange = { name: string; secFrom: number; secTo: number }

/** 按搜索词把文字切片渲染，命中处标黄。查询为空时原样输出（splitByQuery 保证）。
 *  current 传 true 时加深——一屏几十处一样的黄底，看不出跳到了哪一处。 */
function highlight(text: string, query: string, current = false) {
  return splitByQuery(text, query).map((part, i) =>
    part.hit ? (
      <mark key={i} className={`rounded px-0.5 text-foreground ${current ? "bg-amber-300" : "bg-amber-100"}`}>
        {part.text}
      </mark>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  )
}

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
  // 原文搜索：右栏大纲条目自带的条款定位并不总是准，用户要能自己在原文里找
  // （生产反馈：大纲标题定位不准，要能直接从原文查询搜索定位）。
  const [query, setQuery] = useState("")
  const [matchIdx, setMatchIdx] = useState(0)
  const showTabs = (files?.length ?? 0) > 1
  const visible = showTabs && activeFile >= 0 ? sections.filter((s) => inFile(s, files![activeFile]!)) : sections
  // 标题跟着选中的文件走。fileName 是**项目名**（取上传时第一个文件名，也带 .docx），单独挂在页签栏
  // 上方时会被读成"我正在看这份文件"——选了第 3 份、正文也是第 3 份，标题却写着第 1 份的名字。
  const headerName = showTabs && activeFile >= 0 ? files![activeFile]!.name : fileName

  // 本地条款 ref 表：页签过滤会卸载隐藏文件的段落，页面侧同步 scrollIntoView 会扑空——
  // 由下面的效果在（可能的）切页签渲染完成后兜底滚动。
  const localRefs = useRef<Record<string, HTMLParagraphElement | null>>({})

  // 搜索命中：跨全部文件搜（不受当前页签限制），跳到别的文件时自动切页签，与右栏定位同一手法。
  const matches = useMemo(() => searchDocSections(sections, query), [sections, query])
  // 序号就地夹紧：改查询/原文流式增补都会让命中数变化，只靠效果里 setMatchIdx(0) 复位，
  // 中间那一帧会用越界的旧序号——计数器显示「8/2 条」，还会朝错误的命中滚一次。
  const safeIdx = matches.length ? Math.min(matchIdx, matches.length - 1) : 0
  const current = matches[safeIdx]

  // 命中落在别的文件 → 切到该文件页签。**只依赖命中本身**：把 activeFile 也列进依赖的话，
  // 用户手动点页签会重跑本效果，而 current 还指着旧文件的命中，于是被立刻弹回去，
  // 搜索期间根本切不了文件（与既有 activeClauses 效果只依赖 [activeClauses] 同理）。
  useEffect(() => {
    if (!current || !showTabs || activeFile < 0) return
    const n = secNum(current.secId)
    if (Number.isNaN(n)) return
    const f = files![activeFile]!
    if (n >= f.secFrom && n <= f.secTo) return
    const idx = files!.findIndex((fr) => n >= fr.secFrom && n <= fr.secTo)
    if (idx >= 0) setActiveFile(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.clauseId])

  // 滚动到当前命中：依赖含 activeFile——切页签后段落刚挂载，此时 ref 才拿得到
  useEffect(() => {
    if (!current) return
    localRefs.current[current.clauseId]?.scrollIntoView({ behavior: "smooth", block: "center" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.clauseId, activeFile])

  const step = (d: number) => {
    if (matches.length === 0) return
    setMatchIdx((i) => (i + d + matches.length) % matches.length)
  }

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
        <span className="truncate text-sm font-semibold text-foreground">{headerName}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {showTabs ? (activeFile >= 0 ? `原文 · 第 ${activeFile + 1}/${files!.length} 份` : `原文 · ${files!.length} 份文件`) : "原文"}
        </span>
      </header>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setMatchIdx(0) // 同步复位：靠效果复位会先用旧序号渲染一帧并滚错地方
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              } else if (e.key === "Escape") {
                setQuery("")
                setMatchIdx(0)
              }
            }}
            placeholder="在原文中搜索（回车下一处，Shift+回车上一处）"
            className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("")
                setMatchIdx(0)
              }}
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {query.trim() && (
          <div className="flex shrink-0 items-center gap-1">
            <span className="tabular-nums text-xs text-muted-foreground">
              {matches.length ? `${safeIdx + 1}/${matches.length} 条` : "无匹配"}
            </span>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={matches.length === 0}
              aria-label="上一处"
              className="rounded border border-border p-0.5 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={matches.length === 0}
              aria-label="下一处"
              className="rounded border border-border p-0.5 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        )}
      </div>
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
          <p className="py-16 text-center text-sm text-muted-foreground">正在解析招标原文…</p>
        )}
        {sections.length > 0 && visible.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">该文件无可解析条款</p>
        )}
        {/* 排版对齐标书生成页的正文视图（prose-sm 一套）：招标原文是「文档」不是「条款清单」，
            早先每条都套一个圆角灰盒、正文用 muted 小字，读起来像列表、也认不出层级。
            命中高亮保留——右栏点条款定位到原文是核心功能，只是从「整条变色块」收成左侧标线，
            不再喧宾夺主。 */}
        {visible.map((sec) => (
          <section
            key={sec.id}
            className={`rounded-xl px-3 py-2 transition-colors ${
              activeSection === sec.id ? "bg-primary/[0.04]" : ""
            } ${sec.id !== visible[0].id ? "mt-6" : ""}`}
          >
            {/* 按解析出的层级渲染：一级（第N章/节/篇/部分）大一号，二级（「一、」式）小一号。
                拿不到真实标题时 title 会是「第N部分」占位——那时层级一律按 1，不装作有结构。 */}
            {/* 标题同样过高亮：搜章节名时命中的就是标题，落点段落里并没有那个词，
                不标出来的话用户看到「1/1 条」、页面滚了，却一个高亮都找不到，分不清搜没搜到。 */}
            {sec.level >= 2 ? (
              <h4 className="mb-1.5 mt-1 text-sm font-semibold text-foreground">{highlight(sec.title, query)}</h4>
            ) : (
              <h3 className="mb-2 mt-1 text-base font-bold text-foreground">{highlight(sec.title, query)}</h3>
            )}
            {sec.paragraphs.map((clause) => {
              const hit = activeClauses.includes(clause.id)
              const isCurrentMatch = current?.clauseId === clause.id
              return (
                <p
                  key={clause.id}
                  ref={(el) => {
                    localRefs.current[clause.id] = el
                    registerClauseRef(clause.id, el)
                  }}
                  className={`scroll-mt-16 mb-3 text-sm leading-relaxed transition-colors ${
                    hit
                      ? "-ml-3 border-l-2 border-primary bg-primary/10 pl-2.5 font-medium text-foreground"
                      : isCurrentMatch
                        ? "-ml-3 border-l-2 border-amber-500 pl-2.5 text-foreground"
                        : "text-foreground/90"
                  }`}
                >
                  {hit && <MapPin className="mr-1 inline size-3.5 -translate-y-px text-primary" />}
                  {highlight(clause.text, query, isCurrentMatch)}
                </p>
              )
            })}
          </section>
        ))}
      </div>
    </section>
  )
}
