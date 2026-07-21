"use client"

import { Bold, Heading2, ImagePlus, Italic, Library, List, Maximize2, Minimize2, Undo2 } from "lucide-react"

/** 正文编辑工具栏：撤销 + 加粗/斜体/小标题/列表/插图 + 「从资料库插入」+ 全屏切换。
 *  全屏按钮并入工具栏而非独立元素：窄视口断行时整条工具栏一起换行，不会孤零零挤出一行。 */
export function EditorToolbar({
  exec,
  onUndo,
  onOpenLibrary,
  fullscreen,
  onToggleFullscreen,
}: {
  /** 对当前 contentEditable 编辑器执行 document.execCommand */
  exec: (cmd: string, value?: string) => void
  /** 章节级撤销（误删回撤）：先撤未保存改动，再逐级回退历史保存版 */
  onUndo: () => void
  onOpenLibrary: () => void
  /** 工作区全屏态（目录/正文/AI 助手三栏一起铺满，Esc 退出） */
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  function insertImage() {
    const url = "/professional-business-chart.png"
    exec("insertHTML", `<img src="${url}" alt="示意图" class="my-3 rounded-lg border border-border max-w-full" />`)
  }

  return (
    <div className="flex items-center gap-0.5">
      <ToolBtn onClick={onUndo} label="撤销（误删回撤）">
        <Undo2 className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={() => exec("bold")} label="加粗">
        <Bold className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={() => exec("italic")} label="斜体">
        <Italic className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={() => exec("formatBlock", "<h3>")} label="小标题">
        <Heading2 className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={() => exec("insertUnorderedList")} label="列表">
        <List className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={insertImage} label="插入图片">
        <ImagePlus className="size-4" />
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
    </div>
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
