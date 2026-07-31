"use client"

// 一章的子项树编辑器（章 + 四层子项 = 投标惯例的五级：第一章 → 一、 → 1. → （1） → ①）。
// 从 outline/page.tsx 抽出（页面近 800 行上限）：
// - 同层拖拽排序：按「祖先 id 链」判同层（HTML5 原生 DnD;dragstart 必须 setData——Firefox 不设即拒启,评审二轮 F5）
// - 每级可加下一级直至封顶;各级编辑/删除一致;溯源徽标/新增徽标与点击定位逻辑与原实现保真
// - 结构性修改统一经 onChange 交回页面（位置编号重排/保存由页面链路负责）
// - 与页面章标题编辑互斥（评审二轮:重构曾丢互斥）:开编辑时回调 onEditStart,页面 bump closeEditToken 反向关这里
import { useEffect, useState } from "react"
import { Check, CornerDownRight, GripVertical, ListTree, MapPin, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react"
import type { OutlineItem } from "@/lib/bid-types"
import { MAX_OUTLINE_DEPTH, reorderWithin } from "@/lib/outline-edit"
import { OutlineItemDialog } from "./item-dialog"

type Drag = { id: string; parentId: string } // parentId = 祖先 id 链 join("/")，空串=顶层

/** 编辑态单行（各级共用；depth 决定缩进，与展示态对齐）。 */
export function ChapterItems({
  items,
  activeItem,
  locate,
  onItemClick,
  onChange,
  genId,
  onEditStart,
  closeEditToken,
}: {
  items: OutlineItem[]
  activeItem: string
  /** clauseIds → 「章节 N 第 M 段」定位文案（页面既有实现传入） */
  locate: (clauseIds?: string[]) => string
  onItemClick: (clauseIds: string[] | undefined, key: string) => void
  onChange: (items: OutlineItem[]) => void
  genId: () => string
  /** 本组件进入编辑态时通知页面（页面据此关章标题编辑,恢复旧版互斥） */
  onEditStart?: () => void
  /** 页面开章标题编辑时 bump,本组件收敛自身编辑态 */
  closeEditToken?: unknown
}) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [overId, setOverId] = useState<string | null>(null) // 悬停中的同层目标（顶部插入线）

  /** 对某一层做变换：path=祖先 id 链（空=顶层）。递归下钻，支持到五级（MAX_OUTLINE_DEPTH）。 */
  const mutateLevel = (path: string[], fn: (list: OutlineItem[]) => OutlineItem[]) => {
    const walk = (list: OutlineItem[], rest: string[]): OutlineItem[] => {
      if (rest.length === 0) return fn(list)
      const [head, ...tail] = rest
      return list.map((it) => (it.id === head ? { ...it, children: walk(it.children ?? [], tail) } : it))
    }
    onChange(walk(items, path))
  }

  /** 各级新增项的默认名（depth 从 1=节 起算，与提纲编号层级一一对应）。 */
  const LEVEL_NAME = ["", "新增子项", "新增小节", "新增细分项", "新增明细项"]

  /* 新增与编辑共用一个弹窗：除标题名外还要能填「这一节写什么」的说明——它随提纲保存并进入
     正文生成提示词。此前新增是插一个占位项再行内改名、编辑只能改名，用户的写作意图无处可放；
     已有节点同样需要补说明，所以铅笔也走这里，两个入口一个表单。 */
  const [dialog, setDialog] = useState<
    { mode: "add"; path: string[]; levelName: string }
    | { mode: "edit"; path: string[]; levelName: string; item: OutlineItem }
    | null
  >(null)
  const levelNameAt = (depth: number) => LEVEL_NAME[Math.min(depth, LEVEL_NAME.length - 1)]!

  // 页面开始编辑章标题时收起本组件的弹窗（同时编辑两处会让用户分不清在改哪个）
  useEffect(() => setDialog(null), [closeEditToken])

  const add = (path: string[]) =>
    setDialog({ mode: "add", path, levelName: levelNameAt(path.length + 1) })

  const startEdit = (item: OutlineItem, path: string[], depth: number) => {
    onEditStart?.()
    setDialog({ mode: "edit", path, levelName: levelNameAt(depth), item })
  }

  const confirmDialog = (label: string, desc: string) => {
    if (!dialog) return
    if (dialog.mode === "add") {
      onEditStart?.()
      mutateLevel(dialog.path, (list) => [...list, { id: genId(), label, desc, isNew: true }])
    } else {
      const id = dialog.item.id
      mutateLevel(dialog.path, (list) => list.map((it) => (it.id === id ? { ...it, label, desc } : it)))
    }
    setDialog(null)
  }

  /** 同层放置：drag 与目标同一父路径才接受。dropId=null 落到层尾。 */
  const dropOn = (dropId: string | null, path: string[]) => {
    setOverId(null)
    if (!drag || drag.parentId !== path.join("/")) return
    mutateLevel(path, (list) => reorderWithin(list, drag.id, dropId))
    setDrag(null)
  }

  const dragProps = (id: string, path: string[]) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", id) // Firefox 不 setData 即中止拖拽（评审二轮 F5）
      e.dataTransfer.effectAllowed = "move"
      setDrag({ id, parentId: path.join("/") })
    },
    onDragEnd: () => {
      setDrag(null)
      setOverId(null)
    },
    onDragOver: (e: React.DragEvent) => {
      if (drag && drag.parentId === path.join("/") && drag.id !== id) {
        e.preventDefault() // 同层才是合法放置目标
        setOverId(id)
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      // 进入行内子元素也触发 dragleave（mouseout 语义）——真离开本行才熄灭指示线（评审二轮:指示线闪烁）
      if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return
      setOverId((cur) => (cur === id ? null : cur))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dropOn(id, path)
    },
  })

  /** 尾部落点（层内拖到最后一位；插前语义下末位否则不可达,评审二轮 F9）。 */
  const tailDropProps = (path: string[]) => ({
    onDragOver: (e: React.DragEvent) => {
      if (drag?.parentId === path.join("/")) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dropOn(null, path)
    },
  })

  /** 展示态单行（各级共用）：depth 从 1（节）起算，逐级缩进；未到封顶才给「添加下级」。 */
  const row = (item: OutlineItem, path: string[], depth: number) => {
    const indexed = !!item.clauseIds && item.clauseIds.length > 0
    const child = depth > 1
    const canNest = depth < MAX_OUTLINE_DEPTH - 1 // depth 是子项层级(1=节)，章占一级，故减一
    return (
      <div
        {...dragProps(item.id, path)}
        style={child ? { marginLeft: `${(depth - 1) * 1.5}rem` } : undefined}
        className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${child ? "py-1.5" : ""} ${
          overId === item.id ? "border-t-2 border-t-primary" : ""
        } ${
          activeItem === item.id
            ? "border-primary bg-primary/5 ring-1 ring-primary/30"
            : indexed
              ? "border-transparent hover:border-border hover:bg-muted/60"
              : "border-primary/20 bg-primary/5"
        }`}
      >
        <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        <button
          onClick={() => onItemClick(item.clauseIds, item.id)}
          disabled={!indexed}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${indexed ? "cursor-pointer" : "cursor-default"}`}
        >
          {child ? <CornerDownRight className="size-3.5 shrink-0 text-primary/60" /> : <ListTree className="size-3.5 shrink-0 text-primary/60" />}
          <span className="min-w-0 flex-1 truncate text-foreground">{item.label}</span>
        </button>
        {indexed ? (
          /* 定位徽标限宽 45% + 内部截断（生产实测:条款多时绝不挤掉标题）;完整定位见 title */
          <span
            className="inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success"
            title={`定位到 ${locate(item.clauseIds)}`}
          >
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">{locate(item.clauseIds)}</span>
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            <Sparkles className="size-3" />
            新增
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {canNest && (
            <button onClick={() => add([...path, item.id])} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-primary" aria-label="添加下级" title="添加下一级">
              <CornerDownRight className="size-3.5" />
            </button>
          )}
          <button onClick={() => startEdit(item, path, depth)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="编辑标题与说明">
            <Pencil className="size-3.5" />
          </button>
          <button onClick={() => mutateLevel(path, (list) => list.filter((it) => it.id !== item.id))} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="删除本项">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  const renderRow = (item: OutlineItem, path: string[], depth: number) => row(item, path, depth)

  /** 递归渲染一层（含该层尾部落点）。depth 从 1（节）起算，最深到 MAX_OUTLINE_DEPTH-1。 */
  const renderLevel = (list: OutlineItem[], path: string[], depth: number) => (
    <ul className={`flex flex-col gap-1.5 ${depth === 1 ? "mt-2.5" : "mt-1.5"}`}>
      {list.map((item) => (
        <li key={item.id}>
          {renderRow(item, path, depth)}
          {(item.children?.length ?? 0) > 0 && renderLevel(item.children!, [...path, item.id], depth + 1)}
          {/* 该项下级的尾部落点：仅拖动其直接子项时显形 */}
          {drag?.parentId === [...path, item.id].join("/") && (item.children?.length ?? 0) > 0 && (
            <ul className="mt-1.5">
              <li
                {...tailDropProps([...path, item.id])}
                style={{ marginLeft: `${depth * 1.5}rem` }}
                className="h-2 rounded border border-dashed border-primary/40"
                aria-label="移到本层末尾"
              />
            </ul>
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <>
      {renderLevel(items, [], 1)}
      {/* 添加子项;也是顶层拖拽的「移到末尾」落点（拖到按钮上放手） */}
      <button
        onClick={() => add([])}
        {...tailDropProps([])}
        aria-label="添加子项"
        title="添加子项"
        className="mt-2 flex w-full items-center justify-center rounded-lg border border-dashed border-border py-1.5 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        <Plus className="size-4" />
      </button>
      {dialog && (
        <OutlineItemDialog
          mode={dialog.mode}
          levelName={dialog.levelName}
          initialLabel={dialog.mode === "edit" ? dialog.item.label : ""}
          initialDesc={dialog.mode === "edit" ? (dialog.item.desc ?? "") : ""}
          onCancel={() => setDialog(null)}
          onConfirm={confirmDialog}
        />
      )}
    </>
  )
}
