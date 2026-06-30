"use client"

import { useMemo, useState } from "react"
import {
  Library,
  Plus,
  Pencil,
  Trash2,
  Paperclip,
  Upload,
  X,
  AlertTriangle,
  Search,
  Copy,
  Check,
  Tag,
  Star,
} from "lucide-react"
import {
  libraryCategories,
  expiryStatus,
  type LibraryCategory,
  type LibraryCategoryId,
  type LibraryItem,
} from "@/lib/library"
import { useEscapeClose } from "@/hooks/use-escape-close"

const expiryMeta: Record<"ok" | "soon" | "expired", { label: string; cls: string }> = {
  ok: { label: "有效", cls: "bg-success/10 text-success" },
  soon: { label: "临期", cls: "bg-warning/15 text-warning" },
  expired: { label: "已过期", cls: "bg-destructive/10 text-destructive" },
}

export default function LibraryPage() {
  const [cats, setCats] = useState<LibraryCategory[]>(libraryCategories)
  const [activeCat, setActiveCat] = useState<LibraryCategoryId>("qualification")
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<{ catId: LibraryCategoryId; item: LibraryItem | null } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /* 演示用：当前默认企业演示模板 */
  const [defaultTplId, setDefaultTplId] = useState<string>("pe1")

  const totalItems = cats.reduce((n, c) => n + c.items.length, 0)
  const soonCount = cats
    .flatMap((c) => c.items)
    .filter((it) => expiryStatus(it.expiry) === "soon" || expiryStatus(it.expiry) === "expired").length

  const current = cats.find((c) => c.id === activeCat)!
  const filtered = useMemo(() => {
    if (!query.trim()) return current.items
    const q = query.trim().toLowerCase()
    return current.items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.meta?.toLowerCase().includes(q) ||
        it.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }, [current, query])

  function removeItem(catId: LibraryCategoryId, itemId: string) {
    setCats((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, items: c.items.filter((it) => it.id !== itemId) } : c)),
    )
  }

  function saveItem(catId: LibraryCategoryId, item: LibraryItem) {
    setCats((prev) =>
      prev.map((c) => {
        if (c.id !== catId) return c
        const exists = c.items.some((it) => it.id === item.id)
        return {
          ...c,
          items: exists ? c.items.map((it) => (it.id === item.id ? item : it)) : [...c.items, item],
        }
      }),
    )
    setEditing(null)
  }

  function copyBody(item: LibraryItem) {
    if (item.body) navigator.clipboard?.writeText(item.body)
    setCopiedId(item.id)
    setTimeout(() => setCopiedId(null), 1800)
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8 sm:py-10">
      {/* 标题 */}
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
          onClick={() => setEditing({ catId: activeCat, item: null })}
          className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" />
          新增条目
        </button>
      </div>

      {/* 临期提醒 */}
      {soonCount > 0 && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <p className="text-sm text-foreground">
            有 <span className="font-semibold">{soonCount}</span> 项资质临近有效期或已过期，建议尽快更新，避免投标时缺失。
          </p>
        </div>
      )}

      {/* 分类卡片 */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cats.map((c) => {
          const Icon = c.icon
          const active = c.id === activeCat
          return (
            <button
              key={c.id}
              onClick={() => {
                setActiveCat(c.id)
                setQuery("")
              }}
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
              <span className="text-xs text-muted-foreground">{c.items.length} 项</span>
            </button>
          )
        })}
      </div>

      {/* 当前分类内容 */}
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
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索条目 / 标签"
              className="w-40 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>

        <div className="divide-y divide-border">
          {filtered.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">暂无条目，点击右上角「新增条目」开始录入</p>
          )}
          {filtered.map((item) => {
            const es = expiryStatus(item.expiry)
            return (
              <div key={item.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    {es && (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${expiryMeta[es].cls}`}>
                        {es !== "ok" && <AlertTriangle className="size-3" />}
                        {expiryMeta[es].label}
                        {item.expiry ? ` · ${item.expiry}` : ""}
                      </span>
                    )}
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

                  {/* 标签 + 附件 */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {item.tags?.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <Tag className="size-3" />
                        {t}
                      </span>
                    ))}
                    {item.attachments?.map((a) => (
                      <span key={a} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        <Paperclip className="size-3" />
                        {a}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 操作 */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {current.id === "presentation" && item.tags?.includes("企业模板") && (
                    <button
                      onClick={() => setDefaultTplId(item.id)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        defaultTplId === item.id
                          ? "border-primary/40 gradient-brand-soft text-primary"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <Star className={`size-3.5 ${defaultTplId === item.id ? "fill-primary" : ""}`} />
                      {defaultTplId === item.id ? "默认模板" : "设为默认"}
                    </button>
                  )}
                  {item.body && (
                    <button
                      onClick={() => copyBody(item)}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      {copiedId === item.id ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                      {copiedId === item.id ? "已复制" : "复制文本"}
                    </button>
                  )}
                  <button
                    onClick={() => setEditing({ catId: current.id, item })}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="编辑"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    onClick={() => removeItem(current.id, item.id)}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label="删除"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

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

/* ---------------- 新增 / 编辑条目弹层 ---------------- */
function ItemEditor({
  catId,
  item,
  onClose,
  onSave,
}: {
  catId: LibraryCategoryId
  item: LibraryItem | null
  onClose: () => void
  onSave: (catId: LibraryCategoryId, item: LibraryItem) => void
}) {
  useEscapeClose(onClose)
  const isText = catId === "text"
  const isQual = catId === "qualification"
  const [title, setTitle] = useState(item?.title ?? "")
  const [meta, setMeta] = useState(item?.meta ?? "")
  const [expiry, setExpiry] = useState(item?.expiry ?? "")
  const [body, setBody] = useState(item?.body ?? "")
  const [tags, setTags] = useState((item?.tags ?? []).join("、"))
  const [attachments, setAttachments] = useState<string[]>(item?.attachments ?? [])

  function addAttachment() {
    const name = `附件${attachments.length + 1}.pdf`
    setAttachments((a) => [...a, name])
  }

  function submit() {
    if (!title.trim()) return
    onSave(catId, {
      id: item?.id ?? `n${Date.now()}`,
      title: title.trim(),
      meta: meta.trim() || undefined,
      expiry: isQual && expiry ? expiry : undefined,
      body: isText ? body.trim() || undefined : undefined,
      tags: tags
        .split(/[、,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      attachments,
      fields: item?.fields,
    })
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">{item ? "编辑条目" : "新增条目"}</h2>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <label className="block text-xs font-medium text-foreground">名称</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：ISO27001 信息安全管理体系认证"
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />

          <label className="mt-4 block text-xs font-medium text-foreground">说明 / 副信息</label>
          <input
            value={meta}
            onChange={(e) => setMeta(e.target.value)}
            placeholder="如：认证机构、客户名称、职称等"
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />

          {isQual && (
            <>
              <label className="mt-4 block text-xs font-medium text-foreground">有效期至</label>
              <input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              />
            </>
          )}

          {isText && (
            <>
              <label className="mt-4 block text-xs font-medium text-foreground">模板正文</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="输入可一键插入标书的模板段落…"
                className="mt-1.5 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
            </>
          )}

          <label className="mt-4 block text-xs font-medium text-foreground">标签（用、或逗号分隔）</label>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="如：信息安全、千万级"
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />

          <label className="mt-4 block text-xs font-medium text-foreground">附件</label>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {attachments.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                <Paperclip className="size-3" />
                {a}
                <button onClick={() => setAttachments((arr) => arr.filter((_, idx) => idx !== i))} aria-label="移除附件">
                  <X className="size-3 hover:text-destructive" />
                </button>
              </span>
            ))}
            <button
              onClick={addAttachment}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Upload className="size-3" />
              上传附件
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            取消
          </button>
          <button
            onClick={submit}
            disabled={!title.trim()}
            className="rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
