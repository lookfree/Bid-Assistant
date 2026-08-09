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

/* 资格证明文件附录占位图（2026-08-09 附录系统章节 Task 5）：<img data-file-id data-object-key>
   服务端存的永远是无 src 的占位形态，编辑器现取预签名地址填 src 只为当次会话显示。TipTap
   默认 Image 扩展不认识这两个 data-* 属性，解析时会直接丢掉——不显式声明保留，用户随手编辑
   本章别处内容并失焦保存后，这条 fileId 引用就从正文里永久消失，下次再也认不出这是占位图。 */
const keepDataAttr = (name: string) => ({
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute(name),
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [name]: attrs[name] as string } : {}),
})

/* src 的存回规则单独接管（覆盖 Image 默认的「非空即原样输出」）：带 data-file-id 的占位图，
   当前 src 只是本次会话现取的预签名地址，会过期——绝不能存回服务端，否则用户顺手编辑本章
   其它内容触发一次保存，这条迟早失效的死链接就被永久写进正文（设计文档①「预签名过期无
   所谓，下次加载再取」的前提就是服务端永远只存占位形态）。没有 data-file-id 的普通插图
   （本地图片/资料库内嵌图，走的是永久 data URL）不受影响，照常存 src。 */
const credentialAwareSrc = {
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute("src"),
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs["data-file-id"] ? {} : attrs.src ? { src: attrs.src as string } : {},
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
    return {
      ...this.parent?.(),
      class: keepClass,
      width: widthAttr,
      src: credentialAwareSrc,
      "data-file-id": keepDataAttr("data-file-id"),
      "data-object-key": keepDataAttr("data-object-key"),
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView)
  },
})
