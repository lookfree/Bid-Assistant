"use client"

import { type Editor, useEditorState } from "@tiptap/react"
import { Bold, Heading2, ImagePlus, Italic, Library, List, Maximize2, Minimize2, Table, Undo2 } from "lucide-react"

/** 正文编辑工具栏（TipTap,spec329）：撤销 + 加粗/斜体/小标题/列表/字号/插图/插表格 +
 *  「从资料库插入」+ 全屏切换;光标在表格内时追加表格操作条（行列增删/合并拆分/表头行）。 */
export function EditorToolbar({
  editor,
  onUndo,
  onOpenLibrary,
  onInsertImage,
  fullscreen,
  onToggleFullscreen,
}: {
  editor: Editor | null
  /** 章节级撤销（误删回撤）：先撤未保存改动，再逐级回退历史保存版 */
  onUndo: () => void
  onOpenLibrary: () => void
  onInsertImage: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  // 订阅编辑器状态：光标进出表格时工具栏要即时增减表格操作条
  const inTable = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isActive("table") ?? false,
  })
  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor)
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <ToolBtn onClick={onUndo} label="撤销（误删回撤）">
        <Undo2 className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={run((e) => e.chain().focus().toggleBold().run())} label="加粗">
        <Bold className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={run((e) => e.chain().focus().toggleItalic().run())} label="斜体">
        <Italic className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())} label="小标题">
        <Heading2 className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={run((e) => e.chain().focus().toggleBulletList().run())} label="列表">
        <List className="size-4" />
      </ToolBtn>
      {/* 字号：作用于当前选中文字;正文档还原默认字号 */}
      <select
        value=""
        title="字号（先选中文字再选档位）"
        aria-label="字号"
        onChange={(e) => {
          const v = e.target.value
          if (!editor || !v) return
          if (v === "unset") editor.chain().focus().unsetFontSize().run()
          else editor.chain().focus().setFontSize(v).run()
        }}
        className="h-8 rounded-lg border border-transparent bg-transparent px-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
      >
        <option value="" disabled>
          字号
        </option>
        <option value="12px">小</option>
        <option value="unset">正文</option>
        <option value="18px">大</option>
        <option value="24px">特大</option>
      </select>
      <ToolBtn onClick={onInsertImage} label="插入图片">
        <ImagePlus className="size-4" />
      </ToolBtn>
      <ToolBtn
        onClick={run((e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        label="插入表格"
      >
        <Table className="size-4" />
      </ToolBtn>
      <button
        onClick={onOpenLibrary}
        className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-primary/30 gradient-brand-soft px-2.5 py-1.5 text-xs font-medium text-primary transition-opacity hover:opacity-90"
      >
        <Library className="size-3.5" />
        从资料库插入
      </button>
      <ToolBtn onClick={onToggleFullscreen} label={fullscreen ? "退出全屏（Esc）" : "全屏编辑"}>
        {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </ToolBtn>
      {inTable && <TableBar editor={editor} />}
    </div>
  )
}

/* 表格操作条：光标在表格内时出现（合并/拆分需先框选多个单元格） */
function TableBar({ editor }: { editor: Editor | null }) {
  const ops: { label: string; title: string; fn: (e: Editor) => void }[] = [
    { label: "+行", title: "在下方插入一行", fn: (e) => e.chain().focus().addRowAfter().run() },
    { label: "-行", title: "删除当前行", fn: (e) => e.chain().focus().deleteRow().run() },
    { label: "+列", title: "在右侧插入一列", fn: (e) => e.chain().focus().addColumnAfter().run() },
    { label: "-列", title: "删除当前列", fn: (e) => e.chain().focus().deleteColumn().run() },
    { label: "合并", title: "合并选中的单元格（先拖选多个）", fn: (e) => e.chain().focus().mergeCells().run() },
    { label: "拆分", title: "拆分当前单元格", fn: (e) => e.chain().focus().splitCell().run() },
    { label: "表头行", title: "首行表头开/关", fn: (e) => e.chain().focus().toggleHeaderRow().run() },
    { label: "删表", title: "删除整个表格", fn: (e) => e.chain().focus().deleteTable().run() },
  ]
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1 border-l border-border pl-2">
      <span className="text-[11px] text-muted-foreground">表格：</span>
      {ops.map((op) => (
        <button
          key={op.label}
          type="button"
          title={op.title}
          onClick={() => editor && op.fn(editor)}
          className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          {op.label}
        </button>
      ))}
    </span>
  )
}

function ToolBtn({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}
