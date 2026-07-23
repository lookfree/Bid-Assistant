"use client"

import { useRef } from "react"
import { Image } from "@tiptap/extension-image"
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react"

/* 可缩放插图（TipTap，spec329 续）：默认 Image 扩展无缩放手柄，用户插图后无法调大小。
   这里给 image 节点加 width 属性（进出走 inline style，随 getHTML 存回、导出可读），
   并用 React NodeView 在选中态渲染右下角拖拽手柄。拖拽期间只改视觉宽度，松手一次性提交
   updateAttributes（撤销栈只落一条，避免逐像素刷爆撤销）。class 属性沿用旧的保留逻辑。 */

const keepClass = {
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute("class"),
  renderHTML: (attrs: Record<string, unknown>) => (attrs.class ? { class: attrs.class as string } : {}),
}

const widthAttr = {
  default: null as string | null,
  // 优先读 inline style 的 width，兼容旧的 width 属性。
  parseHTML: (el: HTMLElement) => el.style.width || el.getAttribute("width") || null,
  renderHTML: (attrs: Record<string, unknown>) => (attrs.width ? { style: `width: ${attrs.width}; height: auto` } : {}),
}

function ResizableImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const width = (node.attrs.width as string | null) ?? undefined

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const box = boxRef.current
    if (!box) return
    const startX = e.clientX
    const startW = box.offsetWidth
    const onMove = (me: MouseEvent) => {
      box.style.width = `${Math.max(48, startW + (me.clientX - startX))}px` // 拖拽期间仅改视觉
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      updateAttributes({ width: box.style.width }) // 松手一次性提交，撤销栈只一条
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  return (
    <NodeViewWrapper as="div" className="my-2">
      <div
        ref={boxRef}
        className={`relative inline-block max-w-full ${selected ? "outline outline-2 outline-primary" : ""}`}
        style={{ width, lineHeight: 0 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={node.attrs.src as string}
          alt={(node.attrs.alt as string) ?? ""}
          className={(node.attrs.class as string) ?? undefined}
          draggable={false}
          style={{ width: "100%", height: "auto", maxWidth: "100%", display: "block" }}
        />
        {selected && (
          <span
            onMouseDown={startResize}
            title="拖动调整图片大小"
            className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border-2 border-white bg-primary shadow"
          />
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const ResizableImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), class: keepClass, width: widthAttr }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView)
  },
})
