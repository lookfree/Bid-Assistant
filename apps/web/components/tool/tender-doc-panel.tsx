"use client"

import { FileText, MapPin } from "lucide-react"
import type { DocSectionGroup } from "@/lib/doc-sections"

/**
 * read/outline 共用的招标原文左栏：分组渲染 + 命中条款高亮定位。
 * sections 既可以是真实 read 结果 docSections 的分组，也可以是示例 tenderDoc（结构同构）。
 */
export function TenderDocPanel({
  fileName,
  sections,
  activeSection,
  activeClauses,
  registerClauseRef,
}: {
  fileName: string
  sections: DocSectionGroup[]
  /** 弱高亮的所属分组 id */
  activeSection: string
  /** 精确高亮的条款 id（可多条） */
  activeClauses: string[]
  /** 登记条款段落 DOM，供右栏点击后 scrollIntoView 定位 */
  registerClauseRef: (id: string, el: HTMLParagraphElement | null) => void
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <FileText className="size-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold text-foreground">{fileName}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">原文</span>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {sections.map((sec) => (
          <div
            key={sec.id}
            className={`rounded-xl px-3 py-3 transition-colors ${
              activeSection === sec.id ? "bg-primary/[0.04]" : ""
            } ${sec.id !== sections[0].id ? "mt-4" : ""}`}
          >
            <h3 className="text-sm font-bold text-foreground">{sec.title}</h3>
            <div className="mt-2 flex flex-col gap-1.5">
              {sec.paragraphs.map((clause) => {
                const hit = activeClauses.includes(clause.id)
                return (
                  <p
                    key={clause.id}
                    ref={(el) => registerClauseRef(clause.id, el)}
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
