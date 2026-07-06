"use client"

import { useState } from "react"
import { ArrowRight, Library, Paperclip, Search, X } from "lucide-react"
import { libraryCategories, type LibraryCategoryId, type LibraryItem } from "@/lib/library"
import type { LibraryEntry } from "@/lib/library-api"
import { useEscapeClose } from "@/hooks/use-escape-close"

/**
 * 「从资料库插入」选择器（content / present 共用）：
 * 条目数据由页面级 useLibrary 提升传入（避免每开弹层全量重拉），分类切换 + 搜索 + 点击插入。
 */
export function LibraryPicker({
  title = "从资料库插入",
  defaultCat = "text",
  items: all,
  loading,
  error,
  onClose,
  onPick,
}: {
  title?: string
  defaultCat?: LibraryCategoryId
  items: LibraryEntry[]
  loading: boolean
  error: string | null
  onClose: () => void
  onPick: (item: LibraryItem) => void
}) {
  const [cat, setCat] = useState<LibraryCategoryId>(defaultCat)
  const [q, setQ] = useState("")
  useEscapeClose(onClose)

  const inCat = all.filter((it) => it.category === cat)
  const kw = q.trim()
  const items = kw
    ? inCat.filter(
        (it) => it.title.includes(kw) || it.meta?.includes(kw) || it.tags?.some((t) => t.includes(kw)),
      )
    : inCat
  const emptyText = loading ? "资料库加载中…" : (error ?? (kw ? "未找到匹配条目" : "该分类暂无条目，可先到「我的资料库」录入"))

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Library className="size-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

        <FilterBar cat={cat} onCat={setCat} q={q} onQ={setQ} />

        {/* 条目列表 */}
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>}
          <div className="flex flex-col gap-2">
            {items.map((it) => (
              <PickerItem key={it.id} item={it} onPick={onPick} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* 分类切换 + 搜索栏 */
function FilterBar({
  cat,
  onCat,
  q,
  onQ,
}: {
  cat: LibraryCategoryId
  onCat: (id: LibraryCategoryId) => void
  q: string
  onQ: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      {libraryCategories.map((c) => (
        <button
          key={c.id}
          onClick={() => onCat(c.id)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            cat === c.id ? "gradient-brand text-white" : "border border-border bg-background text-muted-foreground hover:text-foreground"
          }`}
        >
          {c.title}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5">
        <Search className="size-3.5 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="搜索"
          className="w-28 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
    </div>
  )
}

/* 单个可插入条目卡片 */
function PickerItem({ item: it, onPick }: { item: LibraryEntry; onPick: (item: LibraryItem) => void }) {
  return (
    <button
      onClick={() => onPick(it)}
      className="group flex items-start justify-between gap-3 rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{it.title}</p>
        {it.meta && <p className="mt-0.5 text-xs text-muted-foreground">{it.meta}</p>}
        {it.fields?.length ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {it.fields.map((f) => `${f.label}：${f.value}`).join(" · ")}
          </p>
        ) : null}
        {it.body && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{it.body}</p>}
        {it.attachments?.length ? (
          <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Paperclip className="size-3" />
            {it.attachments.map((a) => a.name).join("、")}
          </span>
        ) : null}
      </div>
      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
        插入
        <ArrowRight className="size-3.5" />
      </span>
    </button>
  )
}
