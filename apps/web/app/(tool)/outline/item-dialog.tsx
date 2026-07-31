"use client"

import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"

/* 字数上限：标题是提纲里的一行，过长会把树形结构撑变形、导出到 Word 目录里也会折行；
   描述是写给模型的写作要求，几百字足够表达意图，再长就该拆成下一级标题而不是堆在一段里。
   maxLength 只挡输入，提交前再校验一次——中文输入法组词期间 maxLength 在部分浏览器不生效。 */
const LABEL_MAX = 50
const DESC_MAX = 300

/* 提纲标题弹窗（新增与编辑共用）：标题名称（必填）+ 写作说明（选填）。
   说明不是备注——它会随提纲一并保存，并进入正文生成的提示词，用来指导这一节写什么
   （如「重点写对本院场景的理解，强调涉密合规」）。
   编辑也走这里而不是行内改名：已有节点同样需要补写作说明，两个入口用同一个表单，
   用户不必先猜「说明要去哪儿填」。 */
export function OutlineItemDialog({
  mode,
  levelName,
  initialLabel = "",
  initialDesc = "",
  initialNo,
  onCancel,
  onConfirm,
}: {
  mode: "add" | "edit"
  /** 层级名（子项/小节/细分项/明细项），用于标题文案 */
  levelName: string
  initialLabel?: string
  initialDesc?: string
  /** 章节编号（如「第一章」）：给了就多一个可编辑的序号栏——部分标书要求自定义章节编号，
   *  改章节走弹窗后这栏必须跟过来，否则等于把既有能力弄丢了。子项没有编号，不传即可。 */
  initialNo?: string
  onCancel: () => void
  onConfirm: (label: string, desc: string, no?: string) => void
}) {
  const [label, setLabel] = useState(initialLabel)
  const [desc, setDesc] = useState(initialDesc)
  const [no, setNo] = useState(initialNo ?? "")
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
  /* 只拦「用户把它变得更长」，不拦既有的超长内容：字数限制是这次才加的，库里已存在更长的
     标题/说明。一律硬拦会让那些节点被永久锁死——用户只想补一句写作说明，却被迫先去删标题，
     而这个弹窗是章节标题/编号/说明的唯一入口，连章节编号都会一起改不了。 */
  const overLabel = trimmed.length > LABEL_MAX && trimmed.length > initialLabel.trim().length
  const overDesc = desc.trim().length > DESC_MAX && desc.trim().length > initialDesc.trim().length
  const tooLong = overLabel || overDesc
  const submit = () =>
    trimmed && !tooLong && onConfirm(trimmed, desc.trim(), initialNo === undefined ? undefined : no.trim())

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${mode === "add" ? "新增" : "编辑"}${levelName}`}
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
          {mode === "add" ? "新增" : "编辑"}{levelName}
        </h2>

        {initialNo !== undefined && (
          <>
            <label className="mt-5 block text-sm font-medium text-foreground" htmlFor="outline-add-no">
              章节编号
            </label>
            <input
              id="outline-add-no"
              value={no}
              onChange={(e) => setNo(e.target.value)}
              placeholder="第一章"
              maxLength={20}
              className="mt-1.5 w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </>
        )}

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
          maxLength={LABEL_MAX}
          className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        <p className={`mt-1 text-right text-xs tabular-nums ${trimmed.length > LABEL_MAX ? "text-destructive" : "text-muted-foreground"}`}>
          {trimmed.length} / {LABEL_MAX}
        </p>

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="outline-add-desc">
          标题内容描述
        </label>
        <textarea
          id="outline-add-desc"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={4}
          placeholder="这一节希望写什么、突出哪些要点（选填）。生成标书正文时会按此撰写。"
          maxLength={DESC_MAX}
          className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary"
        />
        <p className={`mt-1 text-right text-xs tabular-nums ${desc.trim().length > DESC_MAX ? "text-destructive" : "text-muted-foreground"}`}>
          {desc.trim().length} / {DESC_MAX}
        </p>
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
            disabled={!trimmed || tooLong}
            className="rounded-lg gradient-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
