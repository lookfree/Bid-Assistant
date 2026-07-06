"use client"

import { Bold, Heading2, ImagePlus, Italic, Library, List } from "lucide-react"

/** 正文编辑工具栏：加粗/斜体/小标题/列表/插图 + 「从资料库插入」入口。 */
export function EditorToolbar({
  exec,
  onOpenLibrary,
}: {
  /** 对当前 contentEditable 编辑器执行 document.execCommand */
  exec: (cmd: string, value?: string) => void
  onOpenLibrary: () => void
}) {
  function insertImage() {
    const url = "/professional-business-chart.png"
    exec("insertHTML", `<img src="${url}" alt="示意图" class="my-3 rounded-lg border border-border max-w-full" />`)
  }

  return (
    <div className="flex items-center gap-0.5">
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
