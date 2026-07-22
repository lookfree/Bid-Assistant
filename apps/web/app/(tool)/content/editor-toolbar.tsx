"use client"

import { Bold, Heading2, ImagePlus, Italic, Library, List, Maximize2, Minimize2, Table, Undo2 } from "lucide-react"

/** 正文编辑工具栏：撤销 + 加粗/斜体/小标题/列表/插图/插表格 + 「从资料库插入」+ 全屏切换。
 *  全屏按钮并入工具栏而非独立元素：窄视口断行时整条工具栏一起换行，不会孤零零挤出一行。 */
export function EditorToolbar({
  exec,
  onUndo,
  onOpenLibrary,
  onInsertImage,
  fullscreen,
  onToggleFullscreen,
}: {
  /** 对当前 contentEditable 编辑器执行 document.execCommand */
  exec: (cmd: string, value?: string) => void
  /** 章节级撤销（误删回撤）：先撤未保存改动，再逐级回退历史保存版 */
  onUndo: () => void
  onOpenLibrary: () => void
  /** 选本地图片插入正文（页面持有文件选择器与选区保存/恢复，此前是写死的占位示意图） */
  onInsertImage: () => void
  /** 工作区全屏态（目录/正文/AI 助手三栏一起铺满，Esc 退出） */
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {

  // 插入 3×3 空表（首行加粗当表头，占位文字直接改）：与 AI 生成正文同款裸 table 标签，
  // 编辑器样式与导出 docx 渲染都按既有表格路径处理；表后补空段落，光标能落到表格下方
  function insertTable() {
    const head = `<tr><td><strong>项目</strong></td><td><strong>内容</strong></td><td><strong>说明</strong></td></tr>`
    const row = `<tr><td>　</td><td>　</td><td>　</td></tr>`
    exec("insertHTML", `<table>${head}${row}${row}</table><p>　</p>`)
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
      {/* 字号：作用于当前选中文字（execCommand fontSize 1-7 档）。应用后拨回占位，可连续换档 */}
      <select
        value=""
        title="字号（先选中文字再选档位）"
        aria-label="字号"
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (e.target.value) exec("fontSize", e.target.value)
        }}
        className="h-8 rounded-lg border border-transparent bg-transparent px-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
      >
        <option value="" disabled>
          字号
        </option>
        <option value="2">小</option>
        <option value="3">正文</option>
        <option value="4">大</option>
        <option value="5">特大</option>
      </select>
      <ToolBtn onClick={() => exec("insertUnorderedList")} label="列表">
        <List className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={onInsertImage} label="插入图片">
        <ImagePlus className="size-4" />
      </ToolBtn>
      <ToolBtn onClick={insertTable} label="插入表格">
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
