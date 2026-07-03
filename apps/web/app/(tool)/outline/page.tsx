"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  FileText,
  Briefcase,
  Layers,
  ListTree,
  MapPin,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Pencil,
  Trash2,
  Plus,
  Check,
  X,
} from "lucide-react"
import {
  projectMeta,
  tenderDoc as docSections,
  techChapters as techChaptersData,
  businessChapters as businessChaptersData,
  clauseLocation,
  type OutlineItem,
  type BidChapter,
} from "@/lib/sample-bid"
import { FlowNav } from "@/components/tool/flow-nav"
import { useStep } from "@/lib/use-step"

// agent Outline（camelCase）：chapters[{id,no,title,group,sourced,items[{id,label,clauseIds,isNew}]}]
type RealOutline = { chapters: (BidChapter & { group: "tech" | "business" })[] }

const docFileName = projectMeta.fileName

/* ---------------- 提纲数据（取自全流程共享数据源） ---------------- */
type Chapter = {
  id: string
  no: string
  title: string
  items: OutlineItem[]
}

const toOutline = (list: BidChapter[]): Chapter[] =>
  list.map(({ id, no, title, items }) => ({ id, no, title, items: items.map((it) => ({ ...it })) }))

const initialTechOutline: Chapter[] = toOutline(techChaptersData)
const initialBusinessOutline: Chapter[] = toOutline(businessChaptersData)


type TabId = "tech" | "business" | "full"

const tabs: { id: TabId; name: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术标大纲", icon: FileText },
  { id: "business", name: "商务标大纲", icon: Briefcase },
  { id: "full", name: "全文大纲", icon: Layers },
]

let idCounter = 0
const genId = () => `gen-${Date.now()}-${idCounter++}`

export default function OutlinePage() {
  const clauseRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  const [activeClauses, setActiveClauses] = useState<string[]>([])
  const [activeSection, setActiveSection] = useState<string>(docSections[0].id)
  const [activeItem, setActiveItem] = useState<string>("")
  const [activeTab, setActiveTab] = useState<TabId>("tech")

  const [techChapters, setTechChapters] = useState<Chapter[]>(initialTechOutline)
  const [businessChapters, setBusinessChapters] = useState<Chapter[]>(initialBusinessOutline)

  // 真实项目：进入页面且该步未跑 → 自动生成提纲；结果覆盖示例树
  const { projectId, info, data: real, running, error, start } = useStep<RealOutline>("outline")
  useEffect(() => {
    if (projectId && info && !real && !running && info.project.currentStep === "outline") void start()
  }, [projectId, info, real, running, start])
  useEffect(() => {
    if (!real) return
    setTechChapters(toOutline(real.chapters.filter((c) => c.group === "tech")))
    setBusinessChapters(toOutline(real.chapters.filter((c) => c.group === "business")))
  }, [real])

  // 正在编辑的目标：条目或章节标题
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [editingChapter, setEditingChapter] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // 当前标签对应的分组
  const groups: { label: string; kind: "tech" | "business"; chapters: Chapter[] }[] =
    activeTab === "tech"
      ? [{ label: "技术标", kind: "tech", chapters: techChapters }]
      : activeTab === "business"
        ? [{ label: "商务标", kind: "business", chapters: businessChapters }]
        : [
            { label: "技术标", kind: "tech", chapters: techChapters },
            { label: "商务标", kind: "business", chapters: businessChapters },
          ]

  const allItems = groups.flatMap((g) => g.chapters).flatMap((c) => c.items)
  const indexedCount = allItems.filter((i) => i.clauseIds && i.clauseIds.length > 0).length
  const newCount = allItems.filter((i) => i.isNew).length

  function setter(kind: "tech" | "business") {
    return kind === "tech" ? setTechChapters : setBusinessChapters
  }

  function handleItemClick(clauseIds: string[] | undefined, key: string) {
    if (!clauseIds || clauseIds.length === 0) return
    setActiveClauses(clauseIds)
    setActiveItem(key)
    setActiveSection(clauseIds[0].replace(/-c\d+$/, ""))
    clauseRefs.current[clauseIds[0]]?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  /* -------- 条目编辑 -------- */
  function startEditItem(item: OutlineItem) {
    setEditingChapter(null)
    setEditingItem(item.id)
    setDraft(item.label)
  }

  function saveItem(kind: "tech" | "business", chapterId: string, itemId: string) {
    const text = draft.trim()
    if (!text) {
      setEditingItem(null)
      return
    }
    setter(kind)((prev) =>
      prev.map((ch) =>
        ch.id === chapterId
          ? { ...ch, items: ch.items.map((it) => (it.id === itemId ? { ...it, label: text } : it)) }
          : ch,
      ),
    )
    setEditingItem(null)
    setDraft("")
  }

  function deleteItem(kind: "tech" | "business", chapterId: string, itemId: string) {
    setter(kind)((prev) =>
      prev.map((ch) => (ch.id === chapterId ? { ...ch, items: ch.items.filter((it) => it.id !== itemId) } : ch)),
    )
  }

  function addItem(kind: "tech" | "business", chapterId: string) {
    const newId = genId()
    setter(kind)((prev) =>
      prev.map((ch) =>
        ch.id === chapterId
          ? { ...ch, items: [...ch.items, { id: newId, label: "新增子项", isNew: true }] }
          : ch,
      ),
    )
    setEditingChapter(null)
    setEditingItem(newId)
    setDraft("新增子项")
  }

  /* -------- 章节编辑 -------- */
  function startEditChapter(ch: Chapter) {
    setEditingItem(null)
    setEditingChapter(ch.id)
    setDraft(ch.title)
  }

  function saveChapter(kind: "tech" | "business", chapterId: string) {
    const text = draft.trim()
    if (!text) {
      setEditingChapter(null)
      return
    }
    setter(kind)((prev) => prev.map((ch) => (ch.id === chapterId ? { ...ch, title: text } : ch)))
    setEditingChapter(null)
    setDraft("")
  }

  function deleteChapter(kind: "tech" | "business", chapterId: string) {
    setter(kind)((prev) => prev.filter((ch) => ch.id !== chapterId))
  }

  function addChapter(kind: "tech" | "business") {
    setter(kind)((prev) => {
      const newId = genId()
      const no = `第${prev.length + 1}章`
      return [...prev, { id: newId, no, title: "新增章节", items: [] }]
    })
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <FlowNav current="outline" />
      {running && (
        <div className="mb-4 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 text-sm font-medium text-primary">
          AI 正在基于读标结论搭建技术标/商务标提纲…
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <span>{error}</span>
          <button onClick={() => void start()} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">重试</button>
        </div>
      )}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
            <ListTree className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">标书提纲</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              对齐评分点自动生成投标大纲，可自由增删改，每条均可溯源到招标原文
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <MapPin className="size-3.5" />
            可索引 {indexedCount}
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            <Sparkles className="size-3.5" />
            新增 {newCount}
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* 左侧：原始文档 */}
        <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
          <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <FileText className="size-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold text-foreground">{docFileName}</span>
            <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">原文</span>
          </header>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {docSections.map((sec) => (
              <div
                key={sec.id}
                className={`rounded-xl px-3 py-3 transition-colors ${
                  activeSection === sec.id ? "bg-primary/[0.04]" : ""
                } ${sec.id !== docSections[0].id ? "mt-4" : ""}`}
              >
                <h3 className="text-sm font-bold text-foreground">{sec.title}</h3>
                <div className="mt-2 flex flex-col gap-1.5">
                  {sec.paragraphs.map((clause) => {
                    const hit = activeClauses.includes(clause.id)
                    return (
                      <p
                        key={clause.id}
                        ref={(el) => {
                          clauseRefs.current[clause.id] = el
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

        {/* 右侧：提纲 */}
        <section className="flex flex-col rounded-2xl border border-border bg-card lg:h-[calc(100vh-11rem)] lg:min-h-[600px]">
          <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <ListTree className="size-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold text-foreground">投标文件大纲</span>
            <span className="ml-auto text-xs text-muted-foreground">可编辑 · 点击条目定位原文</span>
          </header>

          {/* 标签栏 */}
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "gradient-brand text-white"
                      : "border border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4" />
                  {tab.name}
                </button>
              )
            })}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.label}>
                  {activeTab === "full" && (
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <span className="rounded-md gradient-brand px-2 py-0.5 text-xs font-semibold text-white">
                        {group.label}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {group.chapters.map((chapter) => (
                      <div key={chapter.id} className="rounded-xl border border-border bg-background p-3">
                        {/* 章节标题行 */}
                        {editingChapter === chapter.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-primary">{chapter.no}</span>
                            <input
                              autoFocus
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveChapter(group.kind, chapter.id)
                                if (e.key === "Escape") setEditingChapter(null)
                              }}
                              className="min-w-0 flex-1 rounded-md border border-primary bg-card px-2 py-1 text-sm font-semibold text-foreground outline-none"
                            />
                            <button
                              onClick={() => saveChapter(group.kind, chapter.id)}
                              className="rounded-md p-1 text-success hover:bg-success/10"
                              aria-label="保存章节标题"
                            >
                              <Check className="size-4" />
                            </button>
                            <button
                              onClick={() => setEditingChapter(null)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                              aria-label="取消"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="group flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-primary">{chapter.no}</span>
                            <h3 className="text-sm font-semibold text-foreground">{chapter.title}</h3>
                            <div className="ml-auto flex items-center gap-0.5">
                              <button
                                onClick={() => startEditChapter(chapter)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-label="编辑章节标题"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button
                                onClick={() => deleteChapter(group.kind, chapter.id)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                aria-label="删除章节"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 子项列表 */}
                        <ul className="mt-2.5 flex flex-col gap-1.5">
                          {chapter.items.map((item) => {
                            const indexed = !!item.clauseIds && item.clauseIds.length > 0
                            const isEditing = editingItem === item.id
                            return (
                              <li key={item.id}>
                                {isEditing ? (
                                  <div className="flex items-center gap-2 rounded-lg border border-primary bg-primary/5 px-2.5 py-1.5">
                                    <ListTree className="size-3.5 shrink-0 text-primary/60" />
                                    <input
                                      autoFocus
                                      value={draft}
                                      onChange={(e) => setDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveItem(group.kind, chapter.id, item.id)
                                        if (e.key === "Escape") setEditingItem(null)
                                      }}
                                      className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                                    />
                                    <button
                                      onClick={() => saveItem(group.kind, chapter.id, item.id)}
                                      className="rounded-md p-1 text-success hover:bg-success/10"
                                      aria-label="保存子项"
                                    >
                                      <Check className="size-4" />
                                    </button>
                                    <button
                                      onClick={() => setEditingItem(null)}
                                      className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                                      aria-label="取消"
                                    >
                                      <X className="size-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <div
                                    className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                                      activeItem === item.id
                                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                                        : indexed
                                          ? "border-transparent hover:border-border hover:bg-muted/60"
                                          : "border-primary/20 bg-primary/5"
                                    }`}
                                  >
                                    <button
                                      onClick={() => handleItemClick(item.clauseIds, item.id)}
                                      disabled={!indexed}
                                      className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                                        indexed ? "cursor-pointer" : "cursor-default"
                                      }`}
                                    >
                                      <ListTree className="size-3.5 shrink-0 text-primary/60" />
                                      <span className="min-w-0 flex-1 truncate text-foreground">{item.label}</span>
                                    </button>
                                    {indexed ? (
                                      <span
                                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success"
                                        title={`定位到 ${clauseLocation(item.clauseIds)}`}
                                      >
                                        <MapPin className="size-3" />
                                        {clauseLocation(item.clauseIds)}
                                      </span>
                                    ) : (
                                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                        <Sparkles className="size-3" />
                                        新增
                                      </span>
                                    )}
                                    <div className="flex shrink-0 items-center gap-0.5">
                                      <button
                                        onClick={() => startEditItem(item)}
                                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                        aria-label="编辑子项"
                                      >
                                        <Pencil className="size-3.5" />
                                      </button>
                                      <button
                                        onClick={() => deleteItem(group.kind, chapter.id, item.id)}
                                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        aria-label="删除子项"
                                      >
                                        <Trash2 className="size-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>

                        {/* 添加子项 */}
                        <button
                          onClick={() => addItem(group.kind, chapter.id)}
                          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                        >
                          <Plus className="size-3.5" />
                          添加子项
                        </button>
                      </div>
                    ))}

                    {/* 添加章节 */}
                    <button
                      onClick={() => addChapter(group.kind)}
                      className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <Plus className="size-4" />
                      添加章节
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* 右下角悬浮：进入正文生成 */}
      <Link
        href="/content"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full gradient-brand px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-opacity hover:opacity-90"
      >
        <CheckCircle2 className="size-4" />
        确认大纲，生成投标正文
        <ArrowRight className="size-4" />
      </Link>
    </div>
  )
}
