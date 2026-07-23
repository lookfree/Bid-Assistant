"use client"

import { useEffect, useRef, type RefObject } from "react"
import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Table } from "@tiptap/extension-table"
import { TableRow } from "@tiptap/extension-table-row"
import { TableCell } from "@tiptap/extension-table-cell"
import { TableHeader } from "@tiptap/extension-table-header"
import { Image } from "@tiptap/extension-image"
import { TextStyle, FontSize } from "@tiptap/extension-text-style"

/* 遗留内容保护（审查修正 2026-07-23）：TipTap 默认 schema 会把不认识的属性剥掉再存回——
   旧表格工具写的 td/th style 列宽、旧插图的 class 会在一次失焦保存后永久丢失。
   显式扩展保留这些属性（进=parseHTML,出=renderHTML,原样往返）。 */
const keepAttr = (name: string) => ({
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute(name),
  renderHTML: (attrs: Record<string, string | null>) => (attrs[name] ? { [name]: attrs[name] } : {}),
})
const CellKeepStyle = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), style: keepAttr("style") }
  },
})
const HeaderKeepStyle = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), style: keepAttr("style") }
  },
})
const ImageKeepClass = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), class: keepAttr("class") }
  },
})

/** 正文富文本编辑器（TipTap,spec329）：HTML 进出与既有存储/导出链路兼容。
 *  外部替换正文（AI 改写/快照回退）由父组件换 key 重挂载（内容与撤销栈一起重置,
 *  不走 setContent——setContent 事务会进撤销栈,导致两层撤销互踩振荡）。
 *  脏标记：只有用户真编辑过（docChanged）失焦才保存——零编辑失焦绝不把
 *  TipTap 归一化后的 HTML 写回服务端（否则每个点过的章都被静默改写）。 */
export function RichEditor({
  html,
  contentClass,
  scrollRef,
  onBlurSave,
  onEditor,
}: {
  html: string
  contentClass: string
  scrollRef?: RefObject<HTMLDivElement | null>
  onBlurSave: (html: string) => void
  onEditor?: (editor: Editor | null) => void
}) {
  const dirty = useRef(false)
  const editor = useEditor({
    immediatelyRender: false, // Next.js SSR：首帧不渲染编辑器,避免水合不一致
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }), // 拖拽列宽
      TableRow,
      HeaderKeepStyle,
      CellKeepStyle,
      ImageKeepClass.configure({ inline: false, allowBase64: true }), // 插图为 data URL 内嵌
      TextStyle,
      FontSize, // 官方扩展（此前手写副本已删,命令同名 setFontSize/unsetFontSize）
    ],
    content: html,
    editorProps: { attributes: { class: contentClass } },
    onUpdate: () => {
      dirty.current = true
    },
    onBlur: ({ editor: ed }) => {
      if (!dirty.current) return
      dirty.current = false
      onBlurSave(ed.getHTML())
    },
  })

  useEffect(() => {
    onEditor?.(editor)
    return () => onEditor?.(null)
  }, [editor, onEditor])

  return (
    <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <EditorContent editor={editor} />
    </div>
  )
}
