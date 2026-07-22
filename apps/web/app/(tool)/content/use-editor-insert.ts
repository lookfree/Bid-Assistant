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
type SavedCaret = { range: Range; node: Node; offset: number }

export function useEditorInsert(editorRef: RefObject<HTMLDivElement | null>) {
  const saved = useRef<SavedCaret | null>(null)

  function capture() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0).cloneRange()
      // 边界快照：Range 是"活"的——弹窗期间正文 DOM 一旦变动，浏览器会把它折叠回容器开头
      //（生产实测：点在文末插入，结果被插到文档开头还跳顶）。恢复前用快照校验有没有被挪动。
      saved.current = { range, node: range.startContainer, offset: range.startOffset }
    } else {
      saved.current = null
    }
  }

  /** 恢复捕获的选区（先校验没被 DOM 变动挪动）；成功返回 true。 */
  function restore(): boolean {
    const ed = editorRef.current
    const s = saved.current
    if (!ed || !s) return false
    ed.focus({ preventScroll: true }) // 不抢滚动：焦点复位本身不许把视口拽回顶部
    const intact = ed.contains(s.range.startContainer) && s.range.startContainer === s.node && s.range.startOffset === s.offset
    if (!intact) return false
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(s.range)
    return true
  }

  function insert(html: string) {
    const ed = editorRef.current
    if (!ed) return
    ed.focus({ preventScroll: true })
    const inserted = restore() && document.execCommand("insertHTML", false, html)
    if (!inserted) {
      // 无光标/选区已被 DOM 变动挪走 → 追加到本章末尾并滚动到位（绝不静默丢弃、绝不误插开头）
      ed.insertAdjacentHTML("beforeend", html)
      ed.scrollTop = ed.scrollHeight
    }
    saved.current = null
  }

  return { capture, restore, insert }
}
