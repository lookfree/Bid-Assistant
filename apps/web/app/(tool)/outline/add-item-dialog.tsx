"use client"

import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"

/* 添加标题弹窗：标题名称（必填）+ 写作说明（选填）。
   说明不是备注——它会随提纲一并保存，并进入正文生成的提示词，用来指导这一节写什么
   （如「重点写对本院场景的理解，强调涉密合规」）。此前只能行内改个标题名，
   用户想表达的写作意图没有任何地方可放。 */
export function AddItemDialog({
  levelName,
  onCancel,
  onConfirm,
}: {
  /** 当前要新增的层级名（子项/小节/细分项/明细项），用于标题文案 */
  levelName: string
  onCancel: () => void
  onConfirm: (label: string, desc: string) => void
}) {
  const [label, setLabel] = useState("")
  const [desc, setDesc] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即聚焦标题输入框：这个弹窗的唯一必填项就是它，少一次点击
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc 关闭：模态框的通行预期，不给的话用户只能去点那个小 ×
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  const trimmed = label.trim()
  const submit = () => trimmed && onConfirm(trimmed, desc.trim())

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`新增${levelName}`}
        className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <button
          onClick={onCancel}
          aria-label="关闭"
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>

        <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
          <span className="h-4 w-1 rounded-full bg-primary" aria-hidden />
          新增{levelName}
        </h2>

        <label className="mt-5 block text-sm font-medium text-foreground" htmlFor="outline-add-label">
          <span className="text-destructive">*</span> 标题名称
        </label>
        <input
          id="outline-add-label"
          ref={inputRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="如：项目实施组织与人员配置"
          className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="outline-add-desc">
          标题内容描述
        </label>
        <textarea
          id="outline-add-desc"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={4}
          placeholder="这一节希望写什么、突出哪些要点（选填）。生成标书正文时会按此撰写。"
          className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary"
        />
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          描述会随提纲一起保存，并在生成标书正文时作为这一节的写作要求。
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!trimmed}
            className="rounded-lg gradient-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
