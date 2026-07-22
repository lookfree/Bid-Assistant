"use client"

import { useMemo, useState } from "react"
import {
  Library,
  Plus,
  Pencil,
  Trash2,
  Paperclip,
  AlertTriangle,
  Search,
  Copy,
  Check,
  Tag,
  Loader2,
} from "lucide-react"
import { libraryCategories, expiryStatus, type LibraryCategoryId, type LibraryCategoryMeta } from "@/lib/library"
import { createEntry, updateEntry, deleteEntry, type LibraryEntry, type LibraryEntryInput } from "@/lib/library-api"
import { useLibrary } from "@/lib/use-library"
import { fileDownloadUrl } from "@/lib/files"
import { copyText } from "@/lib/clipboard"
import { ItemEditor } from "./item-editor"

const expiryMeta: Record<"ok" | "soon" | "expired", { label: string; cls: string }> = {
  ok: { label: "有效", cls: "bg-success/10 text-success" },
  soon: { label: "临期", cls: "bg-warning/15 text-warning" },
  expired: { label: "已过期", cls: "bg-destructive/10 text-destructive" },
}

type Editing = { catId: LibraryCategoryId; item: LibraryEntry | null }

export default function LibraryPage() {
  const { items, setItems, loading, error: loadError, reload } = useLibrary()
  const [activeCat, setActiveCat] = useState<LibraryCategoryId>("qualification")
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<Editing | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const soonCount = items.filter(
    (it) => expiryStatus(it.expiry) === "soon" || expiryStatus(it.expiry) === "expired",
  ).length

  const current = libraryCategories.find((c) => c.id === activeCat)!
  const catItems = useMemo(() => items.filter((it) => it.category === activeCat), [items, activeCat])
  const filtered = useMemo(() => {
    if (!query.trim()) return catItems
    const q = query.trim().toLowerCase()
    return catItems.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.meta?.toLowerCase().includes(q) ||
        it.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }, [catItems, query])

  // 删除：乐观移除；失败不用本地快照回滚（会复活并发已删条目），改为重拉服务端列表
  async function removeItem(itemId: string) {
    setItems((prev) => prev.filter((it) => it.id !== itemId))
    setActionError(null)
    try {
      await deleteEntry(itemId)
    } catch {
      setActionError("删除失败，请重试")
      void reload()
    }
  }

  // 新增/编辑保存：POST/PUT 成功后用后端整行更新本地列表（失败由弹层内部提示并保持打开）
  async function saveItem(input: LibraryEntryInput, id?: string) {
    const row = id ? await updateEntry(id, input) : await createEntry(input)
    setItems((prev) => (id ? prev.map((it) => (it.id === id ? row : it)) : [...prev, row]))
    setEditing(null)
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8 sm:py-10">
      <PageHeader onAdd={() => setEditing({ catId: activeCat, item: null })} />
      <Banners loadError={loadError} actionError={actionError} soonCount={soonCount} onRetry={() => void reload()} />
      <CategoryGrid
        items={items}
        activeCat={activeCat}
        onSelect={(id) => {
          setActiveCat(id)
          setQuery("")
        }}
      />
      <CategoryPanel
        current={current}
        items={filtered}
        loading={loading}
        query={query}
        onQuery={setQuery}
        onEdit={(item) => setEditing({ catId: current.id, item })}
        onRemove={(id) => void removeItem(id)}
        onActionError={setActionError}
      />

      {editing && (
        <ItemEditor
          catId={editing.catId}
          item={editing.item}
          onClose={() => setEditing(null)}
          onSave={saveItem}
        />
      )}
    </div>
  )
}

/* 页头：标题 + 新增按钮 */
function PageHeader({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl gradient-brand">
          <Library className="size-6 text-white" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-foreground">我的资料库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一次录入、自动复用，写每一份标书时直接调用，越用越省时间。
          </p>
        </div>
      </div>
      <button
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
      >
        <Plus className="size-4" />
        新增条目
      </button>
    </div>
  )
}

/* 加载失败 / 操作失败 / 临期提醒 */
function Banners({
  loadError,
  actionError,
  soonCount,
  onRetry,
}: {
  loadError: string | null
  actionError: string | null
  soonCount: number
  onRetry: () => void
}) {
  return (
    <>
      {loadError && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <p className="text-sm text-foreground">{loadError}</p>
          <button onClick={onRetry} className="ml-auto shrink-0 text-sm font-medium text-primary hover:underline">
            重试
          </button>
        </div>
      )}
      {actionError && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <p className="text-sm text-foreground">{actionError}</p>
        </div>
      )}
      {soonCount > 0 && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <p className="text-sm text-foreground">
            有 <span className="font-semibold">{soonCount}</span> 项资质临近有效期或已过期，建议尽快更新，避免投标时缺失。
          </p>
        </div>
      )}
    </>
  )
}

/* 分类卡片 */
function CategoryGrid({
  items,
  activeCat,
  onSelect,
}: {
  items: LibraryEntry[]
  activeCat: LibraryCategoryId
  onSelect: (id: LibraryCategoryId) => void
}) {
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {libraryCategories.map((c) => {
        const Icon = c.icon
        const active = c.id === activeCat
        const count = items.filter((it) => it.category === c.id).length
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-colors ${
              active ? "border-primary/40 gradient-brand-soft" : "border-border bg-card hover:border-primary/30"
            }`}
          >
            <span
              className={`flex size-9 items-center justify-center rounded-xl ${
                active ? "gradient-brand text-white" : "bg-muted text-muted-foreground"
              }`}
            >
              <Icon className="size-5" />
            </span>
            <span className="text-sm font-semibold text-foreground">{c.title}</span>
            <span className="text-xs text-muted-foreground">{count} 项</span>
          </button>
        )
      })}
    </div>
  )
}

/* 当前分类内容：搜索 + 条目列表 */
function CategoryPanel({
  current,
  items,
  loading,
  query,
  onQuery,
  onEdit,
  onRemove,
  onActionError,
}: {
  current: LibraryCategoryMeta
  items: LibraryEntry[]
  loading: boolean
  query: string
  onQuery: (q: string) => void
  onEdit: (item: LibraryEntry) => void
  onRemove: (id: string) => void
  onActionError: (msg: string | null) => void
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  function copyBody(item: LibraryEntry) {
    if (item.body) void copyText(item.body) // 共享工具：HTTP 环境走 execCommand 降级（裸 clipboard 在本环境静默失效）
    setCopiedId(item.id)
    setTimeout(() => setCopiedId(null), 1800)
  }

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{current.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{current.desc}</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索条目 / 标签"
            className="w-40 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      </div>

      <div className="divide-y divide-border">
        {loading && (
          <p className="inline-flex w-full items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            资料库加载中…
          </p>
        )}
        {!loading && items.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">暂无条目，点击右上角「新增条目」开始录入</p>
        )}
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            copied={copiedId === item.id}
            onCopy={() => copyBody(item)}
            onEdit={() => onEdit(item)}
            onRemove={() => onRemove(item.id)}
            onActionError={onActionError}
          />
        ))}
      </div>
    </div>
  )
}

/* 单条目行：信息 + 标签/附件 + 操作 */
function ItemRow({
  item,
  copied,
  onCopy,
  onEdit,
  onRemove,
  onActionError,
}: {
  item: LibraryEntry
  copied: boolean
  onCopy: () => void
  onEdit: () => void
  onRemove: () => void
  onActionError: (msg: string | null) => void
}) {
  // 点击附件名：取预签名下载 URL，浏览器直下
  async function openAttachment(fileId: string) {
    onActionError(null)
    try {
      window.open(await fileDownloadUrl(fileId), "_blank")
    } catch {
      onActionError("获取附件下载链接失败，请重试")
    }
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{item.title}</p>
          <ExpiryBadge expiry={item.expiry} />
        </div>
        {item.meta && <p className="mt-1 text-xs text-muted-foreground">{item.meta}</p>}

        {item.fields && item.fields.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {item.fields.map((f) => (
              <span key={f.label} className="text-xs text-muted-foreground">
                <span className="text-foreground/70">{f.label}：</span>
                {f.value}
              </span>
            ))}
          </div>
        )}

        {item.body && (
          <p className="mt-2 line-clamp-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">{item.body}</p>
        )}

        {/* 标签 + 附件（点击附件名下载） */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {item.tags?.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              <Tag className="size-3" />
              {t}
            </span>
          ))}
          {item.attachments?.map((a) => (
            <button
              key={a.fileId}
              onClick={() => void openAttachment(a.fileId)}
              title="点击下载附件"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Paperclip className="size-3" />
              {a.name}
            </button>
          ))}
        </div>
      </div>

      <ItemRowActions hasBody={!!item.body} copied={copied} onCopy={onCopy} onEdit={onEdit} onRemove={onRemove} />
    </div>
  )
}

/* 有效期徽标：有效 / 临期 / 已过期（无有效期不渲染） */
function ExpiryBadge({ expiry }: { expiry?: string | null }) {
  const es = expiryStatus(expiry)
  if (!es) return null
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${expiryMeta[es].cls}`}>
      {es !== "ok" && <AlertTriangle className="size-3" />}
      {expiryMeta[es].label}
      {expiry ? ` · ${expiry}` : ""}
    </span>
  )
}

/* 条目操作区：复制文本 / 编辑 / 删除 */
function ItemRowActions({
  hasBody,
  copied,
  onCopy,
  onEdit,
  onRemove,
}: {
  hasBody: boolean
  copied: boolean
  onCopy: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {hasBody && (
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          {copied ? "已复制" : "复制文本"}
        </button>
      )}
      <button
        onClick={onEdit}
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="编辑"
      >
        <Pencil className="size-4" />
      </button>
      <button
        onClick={onRemove}
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        aria-label="删除"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  )
}
