"use client"

import { useEffect, useState, type RefObject } from "react"

/** 光标所在的表格单元（须在编辑器内）；不在表格里返回 null。 */
function currentCell(editorRef: RefObject<HTMLDivElement | null>): HTMLTableCellElement | null {
  const sel = window.getSelection()
  const n = sel?.anchorNode
  if (!n) return null
  const el = n instanceof Element ? n : n.parentElement
  const cell = el?.closest("td,th") as HTMLTableCellElement | null
  return cell && editorRef.current?.contains(cell) ? cell : null
}

/* 表格结构操作（按简单表处理：AI 产出与「插入表格」都是无 colspan 的规整表；
   含 colspan 的复杂表按 cellIndex 操作可能错位，属可接受边界）。 */

function tableOf(cell: HTMLTableCellElement) {
  return { table: cell.closest("table")!, row: cell.parentElement as HTMLTableRowElement, col: cell.cellIndex }
}

function addRow(cell: HTMLTableCellElement) {
  const { row } = tableOf(cell)
  const clone = row.cloneNode(true) as HTMLTableRowElement
  clone.querySelectorAll("td,th").forEach((c) => (c.innerHTML = "　"))
  row.after(clone)
}

function delRow(cell: HTMLTableCellElement) {
  const { table, row } = tableOf(cell)
  if (table.rows.length > 1) row.remove()
}

function addCol(cell: HTMLTableCellElement) {
  const { table, col } = tableOf(cell)
  for (const r of Array.from(table.rows)) {
    const ref = r.cells[Math.min(col, r.cells.length - 1)]
    const c = document.createElement(ref?.tagName === "TH" ? "th" : "td")
    c.innerHTML = "　"
    ref ? ref.after(c) : r.appendChild(c)
  }
}

function delCol(cell: HTMLTableCellElement) {
  const { table, col } = tableOf(cell)
  if ((table.rows[0]?.cells.length ?? 0) <= 1) return
  for (const r of Array.from(table.rows)) r.cells[col]?.remove()
}

/** 均分列宽：table-layout fixed + 每列等宽（治「某列被浏览器自动拉得极宽」）。 */
function equalizeCols(cell: HTMLTableCellElement) {
  const { table } = tableOf(cell)
  const cols = table.rows[0]?.cells.length ?? 0
  if (!cols) return
  table.style.tableLayout = "fixed"
  table.style.width = "100%"
  for (const r of Array.from(table.rows)) for (const c of Array.from(r.cells)) c.style.width = `${100 / cols}%`
}

/** 调本列宽（±5 个百分点，8%~80% 夹住）；未设过宽度先均分一次再调。 */
function resizeCol(cell: HTMLTableCellElement, delta: number) {
  const { table, col } = tableOf(cell)
  if (!table.style.tableLayout) equalizeCols(cell)
  const cur = parseFloat(table.rows[0]?.cells[col]?.style.width || "0") || 100 / (table.rows[0]?.cells.length || 1)
  const next = Math.min(80, Math.max(8, cur + delta))
  for (const r of Array.from(table.rows)) {
    const c = r.cells[col]
    if (c) c.style.width = `${next}%`
  }
}

/** 光标在表格内时浮现的表格操作条：行列增删 + 列宽调整。操作后回调保存。 */
export function TableTools({ editorRef, onChanged }: { editorRef: RefObject<HTMLDivElement | null>; onChanged: () => void }) {
  const [cell, setCell] = useState<HTMLTableCellElement | null>(null)
  useEffect(() => {
    const onSel = () => setCell(currentCell(editorRef))
    document.addEventListener("selectionchange", onSel)
    return () => document.removeEventListener("selectionchange", onSel)
  }, [editorRef])
  if (!cell || !cell.isConnected) return null

  const ops: { label: string; title: string; fn: (c: HTMLTableCellElement) => void }[] = [
    { label: "+行", title: "在下方插入一行", fn: addRow },
    { label: "-行", title: "删除当前行", fn: delRow },
    { label: "+列", title: "在右侧插入一列", fn: addCol },
    { label: "-列", title: "删除当前列", fn: delCol },
    { label: "均分列宽", title: "所有列等宽", fn: equalizeCols },
    { label: "本列变窄", title: "当前列宽 -5%", fn: (c) => resizeCol(c, -5) },
    { label: "本列变宽", title: "当前列宽 +5%", fn: (c) => resizeCol(c, 5) },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-1.5">
      <span className="text-[11px] text-muted-foreground">表格：</span>
      {ops.map((op) => (
        <button
          key={op.label}
          type="button"
          title={op.title}
          onMouseDown={(e) => e.preventDefault() /* 别抢走编辑器选区，否则拿不到当前单元格 */}
          onClick={() => {
            if (!cell.isConnected) return
            op.fn(cell)
            onChanged()
          }}
          className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          {op.label}
        </button>
      ))}
    </div>
  )
}
