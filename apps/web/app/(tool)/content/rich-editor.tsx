"use client"

import { useEffect, type RefObject } from "react"
import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Table } from "@tiptap/extension-table"
import { TableRow } from "@tiptap/extension-table-row"
import { TableCell } from "@tiptap/extension-table-cell"
import { TableHeader } from "@tiptap/extension-table-header"
import { Image } from "@tiptap/extension-image"
import { TextStyle } from "@tiptap/extension-text-style"
import { Extension } from "@tiptap/core"

/* 字号扩展（spec329）：挂在 textStyle mark 上,产出 style="font-size:…" 的纯 HTML——
   存储/导出链路零改动。 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType
      unsetFontSize: () => ReturnType
    }
  }
}

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.fontSize || null,
            renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setFontSize:
        (size) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    }
  },
})

/** 正文富文本编辑器（TipTap,spec329）：HTML 进出与既有存储/导出链路兼容;
 *  表格可拖拽列宽/合并拆分;失焦回调吐 HTML 走既有保存语义。 */
export function RichEditor({
  html,
  contentClass,
  scrollRef,
  onBlurSave,
  onEditor,
}: {
  html: string
  /** 应用在可编辑区元素上的排版样式（沿用原 contenteditable 的 prose 类） */
  contentClass: string
  /** 滚动容器 ref（「定位到本章」滚顶用） */
  scrollRef?: RefObject<HTMLDivElement | null>
  onBlurSave: (html: string) => void
  onEditor?: (editor: Editor | null) => void
}) {
  const editor = useEditor({
    immediatelyRender: false, // Next.js SSR：首帧不渲染编辑器,避免水合不一致
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }), // 拖拽列宽
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false, allowBase64: true }), // 插图为 data URL 内嵌（spec 无外链图）
      TextStyle,
      FontSize,
    ],
    content: html,
    editorProps: { attributes: { class: contentClass } },
    onBlur: ({ editor: ed }) => onBlurSave(ed.getHTML()),
  })

  useEffect(() => {
    onEditor?.(editor)
    return () => onEditor?.(null)
  }, [editor, onEditor])

  // AI 改写/撤销快照等外部替换正文：html 变化且与编辑器现值不同才重置（失焦保存回写同值不打断编辑）
  useEffect(() => {
    if (editor && html !== editor.getHTML()) editor.commands.setContent(html)
  }, [html, editor])

  return (
    <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <EditorContent editor={editor} />
    </div>
  )
}
