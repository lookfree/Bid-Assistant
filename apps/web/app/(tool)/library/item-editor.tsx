"use client"

import { useRef, useState } from "react"
import { Loader2, Paperclip, Upload, X } from "lucide-react"
import type { LibraryAttachment, LibraryCategoryId } from "@/lib/library"
import type { LibraryEntry, LibraryEntryInput } from "@/lib/library-api"
import { uploadFile, uploadErrorMessage } from "@/lib/files"
import { useEscapeClose } from "@/hooks/use-escape-close"

const inputCls =
  "mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"

/** 表单文本字段集合（附件单独管理） */
type EditorForm = { title: string; meta: string; expiry: string; body: string; tags: string }

/**
 * 表单 → 保存入参序列化。
 * 编辑（PUT）契约为「缺键=不改，null=清空」：可空字段一律显式发值或 null，绝不发 undefined 丢键
 * （否则清空不生效）；新建（POST）保持只发有值字段。fields 编辑器不维护，编辑时原样回传。
 */
function buildEntryInput(
  catId: LibraryCategoryId,
  item: LibraryEntry | null,
  form: EditorForm,
  attachments: LibraryAttachment[],
): LibraryEntryInput {
  const title = form.title.trim()
  const meta = form.meta.trim()
  const body = catId === "text" ? form.body.trim() : ""
  const expiry = catId === "qualification" ? form.expiry : ""
  const tags = form.tags
    .split(/[、,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!item) {
    return {
      category: catId,
      title,
      ...(meta ? { meta } : {}),
      ...(expiry ? { expiry } : {}),
      ...(body ? { body } : {}),
      ...(tags.length ? { tags } : {}),
      ...(attachments.length ? { attachments } : {}),
    }
  }
  return {
    category: catId,
    title,
    meta: meta || null,
    expiry: expiry || null,
    body: body || null,
    tags: tags.length ? tags : null,
    attachments: attachments.length ? attachments : null,
    fields: item.fields ?? null,
  }
}

/* ---------------- 新增 / 编辑条目弹层（保存走 POST/PUT，附件走真实直传） ---------------- */
export function ItemEditor({
  catId,
  item,
  onClose,
  onSave,
}: {
  catId: LibraryCategoryId
  item: LibraryEntry | null
  onClose: () => void
  /** 保存回调：由页面调 createEntry / updateEntry，成功后关闭弹层 */
  onSave: (input: LibraryEntryInput, id?: string) => Promise<void>
}) {
  useEscapeClose(onClose)
  const [form, setForm] = useState<EditorForm>({
    title: item?.title ?? "",
    meta: item?.meta ?? "",
    expiry: item?.expiry ?? "",
    body: item?.body ?? "",
    tags: (item?.tags ?? []).join("、"),
  })
  const [attachments, setAttachments] = useState<LibraryAttachment[]>(item?.attachments ?? [])
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setField = (key: keyof EditorForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }))

  async function submit() {
    if (!form.title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(buildEntryInput(catId, item, form, attachments), item?.id)
    } catch {
      setError("保存失败，请重试")
      setSaving(false)
    }
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
          <EditorFields catId={catId} form={form} setField={setField} />
          <label className="mt-4 block text-xs font-medium text-foreground">附件</label>
          <AttachmentsField
            attachments={attachments}
            setAttachments={setAttachments}
            uploading={uploading}
            setUploading={setUploading}
            onError={setError}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          {error && <p className="mr-auto text-xs text-destructive">{error}</p>}
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!form.title.trim() || saving || uploading}
            className="rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}

/* 文本字段区：名称 / 说明 / 有效期（资质类）/ 模板正文（文本类）/ 标签 */
function EditorFields({
  catId,
  form,
  setField,
}: {
  catId: LibraryCategoryId
  form: EditorForm
  setField: (key: keyof EditorForm) => (value: string) => void
}) {
  return (
    <>
      <label className="block text-xs font-medium text-foreground">名称</label>
      <input value={form.title} onChange={(e) => setField("title")(e.target.value)} placeholder="如：ISO27001 信息安全管理体系认证" className={inputCls} />

      <label className="mt-4 block text-xs font-medium text-foreground">说明 / 副信息</label>
      <input value={form.meta} onChange={(e) => setField("meta")(e.target.value)} placeholder="如：认证机构、客户名称、职称等" className={inputCls} />

      {catId === "qualification" && (
        <>
          <label className="mt-4 block text-xs font-medium text-foreground">有效期至</label>
          <input type="date" value={form.expiry} onChange={(e) => setField("expiry")(e.target.value)} className={inputCls} />
        </>
      )}

      {catId === "text" && (
        <>
          <label className="mt-4 block text-xs font-medium text-foreground">模板正文</label>
          <textarea
            value={form.body}
            onChange={(e) => setField("body")(e.target.value)}
            rows={5}
            placeholder="输入可一键插入标书的模板段落…"
            className="mt-1.5 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </>
      )}

      <label className="mt-4 block text-xs font-medium text-foreground">标签（用、或逗号分隔）</label>
      <input value={form.tags} onChange={(e) => setField("tags")(e.target.value)} placeholder="如：信息安全、千万级" className={inputCls} />
    </>
  )
}

/* 附件列表 + 上传按钮：三段式直传（presign → PUT → complete），成功后以 {fileId,name} 记入条目 */
function AttachmentsField({
  attachments,
  setAttachments,
  uploading,
  setUploading,
  onError,
}: {
  attachments: LibraryAttachment[]
  setAttachments: React.Dispatch<React.SetStateAction<LibraryAttachment[]>>
  uploading: boolean
  setUploading: (v: boolean) => void
  onError: (msg: string | null) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  async function onFilePicked(fileList: FileList | null) {
    const file = fileList?.[0]
    if (!file || uploading) return
    setUploading(true)
    onError(null)
    try {
      const uploaded = await uploadFile(file)
      setAttachments((arr) => [...arr, uploaded])
    } catch (e) {
      onError(uploadErrorMessage(e, "附件上传失败，请重试")) // 类型/大小被拒给具体原因，别让用户拿坏文件反复重试
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {attachments.map((a, i) => (
        <span key={`${a.fileId}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          <Paperclip className="size-3" />
          {a.name}
          <button onClick={() => setAttachments((arr) => arr.filter((_, idx) => idx !== i))} aria-label="移除附件">
            <X className="size-3 hover:text-destructive" />
          </button>
        </span>
      ))}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
      >
        {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
        {uploading ? "上传中…" : "上传附件"}
      </button>
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => void onFilePicked(e.target.files)} />
    </div>
  )
}
