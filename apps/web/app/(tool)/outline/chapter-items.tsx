"use client"

// 一章的子项树编辑器（评审需求:三级提纲 章→节→小节）。从 outline/page.tsx 抽出（页面近 800 行上限）：
// - 同层拖拽排序：节在本章内、小节在本节内（HTML5 原生 DnD,不引第三方库;跨层/跨章不放行）
// - 节可添加小节;两层的编辑/删除一致;溯源徽标/新增徽标与点击定位逻辑与原实现保真
// - 结构性修改统一经 onChange 交回页面（编号重排/保存仍由页面的既有链路负责）
import { useState } from "react"
import { Check, CornerDownRight, GripVertical, ListTree, MapPin, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react"
import type { OutlineItem } from "@/lib/bid-types"
import { reorderWithin } from "@/lib/outline-edit"

type Drag = { id: string; parentId: string | null }

export function ChapterItems({
  items,
  activeItem,
  locate,
  onItemClick,
  onChange,
  genId,
}: {
  items: OutlineItem[]
  activeItem: string
  /** clauseIds → 「章节 N 第 M 段」定位文案（页面既有实现传入） */
  locate: (clauseIds?: string[]) => string
  onItemClick: (clauseIds: string[] | undefined, key: string) => void
  onChange: (items: OutlineItem[]) => void
  genId: () => string
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [drag, setDrag] = useState<Drag | null>(null)
  const [overId, setOverId] = useState<string | null>(null) // 当前悬停的同层目标（顶部插入线指示）

  /** 对某一层做变换：parentId=null 变换顶层,否则变换该节的 children。 */
  const mutateLevel = (parentId: string | null, fn: (list: OutlineItem[]) => OutlineItem[]) => {
    if (parentId == null) return onChange(fn(items))
    onChange(items.map((it) => (it.id === parentId ? { ...it, children: fn(it.children ?? []) } : it)))
  }

  const saveLabel = (id: string, parentId: string | null) => {
    const text = draft.trim()
    setEditingId(null)
    setDraft("")
    if (!text) return
    mutateLevel(parentId, (list) => list.map((it) => (it.id === id ? { ...it, label: text } : it)))
  }

  const remove = (id: string, parentId: string | null) =>
    mutateLevel(parentId, (list) => list.filter((it) => it.id !== id))

  const add = (parentId: string | null) => {
    const id = genId()
    const label = parentId == null ? "新增子项" : "新增小节"
    mutateLevel(parentId, (list) => [...list, { id, label, isNew: true }])
    setEditingId(id)
    setDraft(label)
  }

  /** 同层放置：drag 与目标 parentId 一致才接受（节↔节、同节小节↔小节）。dropId=null 落到层尾。 */
  const dropOn = (dropId: string | null, parentId: string | null) => {
    setOverId(null)
    if (!drag || drag.parentId !== parentId) return
    mutateLevel(parentId, (list) => reorderWithin(list, drag.id, dropId))
    setDrag(null)
  }

  const dragProps = (id: string, parentId: string | null) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move"
      setDrag({ id, parentId })
    },
    onDragEnd: () => {
      setDrag(null)
      setOverId(null)
    },
    onDragOver: (e: React.DragEvent) => {
      if (drag && drag.parentId === parentId && drag.id !== id) {
        e.preventDefault() // 同层才是合法放置目标
        setOverId(id)
      }
    },
    onDragLeave: () => setOverId((cur) => (cur === id ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dropOn(id, parentId)
    },
  })

  /** 单行（节/小节共用;小节缩进 + 角标图标 + 无「添加小节」按钮）。 */
  const row = (item: OutlineItem, parentId: string | null) => {
    const indexed = !!item.clauseIds && item.clauseIds.length > 0
    const child = parentId != null
    if (editingId === item.id) {
      return (
        <div className={`flex items-center gap-2 rounded-lg border border-primary bg-primary/5 px-2.5 py-1.5 ${child ? "ml-6" : ""}`}>
          {child ? <CornerDownRight className="size-3.5 shrink-0 text-primary/60" /> : <ListTree className="size-3.5 shrink-0 text-primary/60" />}
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveLabel(item.id, parentId)
              if (e.key === "Escape") setEditingId(null)
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          />
          <button onClick={() => saveLabel(item.id, parentId)} className="rounded-md p-1 text-success hover:bg-success/10" aria-label="保存">
            <Check className="size-4" />
          </button>
          <button onClick={() => setEditingId(null)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="取消">
            <X className="size-4" />
          </button>
        </div>
      )
    }
    return (
      <div
        {...dragProps(item.id, parentId)}
        className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${child ? "ml-6 py-1.5" : ""} ${
          overId === item.id ? "border-t-2 border-t-primary" : ""
        } ${
          activeItem === item.id
            ? "border-primary bg-primary/5 ring-1 ring-primary/30"
            : indexed
              ? "border-transparent hover:border-border hover:bg-muted/60"
              : "border-primary/20 bg-primary/5"
        }`}
      >
        <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" aria-label="拖动排序" />
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
          {!child && (
            <button
              onClick={() => add(item.id)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-primary"
              aria-label="添加小节"
              title="添加小节"
            >
              <CornerDownRight className="size-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              setEditingId(item.id)
              setDraft(item.label)
            }}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={child ? "编辑小节" : "编辑子项"}
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            onClick={() => remove(item.id, parentId)}
            className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={child ? "删除小节" : "删除子项"}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            {row(item, null)}
            {(item.children?.length ?? 0) > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {item.children!.map((c) => (
                  <li key={c.id}>{row(c, item.id)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {/* 添加子项;也是顶层拖拽的「移到末尾」落点（拖到按钮上放手） */}
      <button
        onClick={() => add(null)}
        onDragOver={(e) => {
          if (drag?.parentId === null) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          dropOn(null, null)
        }}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        <Plus className="size-3.5" />
        添加子项
      </button>
    </>
  )
}
