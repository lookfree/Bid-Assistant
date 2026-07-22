"use client"

import { useRef, type RefObject } from "react"
import { type LibraryItem } from "@/lib/library"

/** 资料条目 → 可插入的 HTML 片段：有正文逐行成段；无正文拼标题/字段/附件摘要。 */
export function libraryItemHtml(item: LibraryItem): string {
  if (item.body) {
    return item.body
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${line}</p>`)
      .join("")
  }
  const parts: string[] = [`<strong>${item.title}</strong>`]
  if (item.meta) parts.push(item.meta)
  if (item.fields?.length) parts.push(item.fields.map((f) => `${f.label}：${f.value}`).join("；"))
  if (item.attachments?.length) parts.push(`附件：${item.attachments.map((a) => a.name).join("、")}`)
  return `<p>${parts.join("，")}。</p>`
}

/** 编辑器选区插入（生产实测「点了插入却没插进去」）：打开弹窗/点击条目过程中选区已离开编辑器，
 *  此时 execCommand("insertHTML") 会静默失败。故打开弹窗前 capture() 保存编辑器内选区，
 *  insert() 恢复选区插入；无有效光标（用户从没点过正文）或插入失败则追加到本章末尾并滚到位
 *  ——保证插入一定可见，绝不静默丢弃。 */
export function useEditorInsert(editorRef: RefObject<HTMLDivElement | null>) {
  const saved = useRef<Range | null>(null)

  function capture() {
    const sel = window.getSelection()
    saved.current =
      sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null
  }

  function insert(html: string) {
    editorRef.current?.focus()
    let inserted = false
    const range = saved.current
    if (range && editorRef.current?.contains(range.startContainer)) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      inserted = document.execCommand("insertHTML", false, html)
    }
    if (!inserted && editorRef.current) {
      editorRef.current.insertAdjacentHTML("beforeend", html)
      editorRef.current.scrollTop = editorRef.current.scrollHeight
    }
    saved.current = null
  }

  return { capture, insert }
}
