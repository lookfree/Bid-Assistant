"use client"

import { type LibraryItem } from "@/lib/library"
import { fileDownloadUrl } from "@/lib/files"
import { imageUrlToDataUrl } from "@/lib/image-insert"

/** 资料库存的是纯文本，拼进 HTML 前必须转义：「响应时间 < 2 小时」「A&B 公司」这类内容
 *  直接拼会被浏览器当标签/实体解析，轻则显示错乱，重则从 '<' 起后半句整段被吞（静默丢内容）。 */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** 属性值转义：alt 里出现引号会把属性提前收尾，后面的内容跑到标签外。 */
function escAttr(text: string): string {
  return esc(text).replace(/"/g, "&quot;")
}

const IMAGE_EXT = /\.(png|jpe?g)$/i

/** 该附件是不是可内嵌的图片。资质证照多是 png/jpg 扫描件；pdf/xlsx 无法内嵌，仍按文件名列出。 */
export function isImageAttachment(a: { name: string }): boolean {
  return IMAGE_EXT.test(a.name || "")
}

/** 资料条目 → 可插入的 HTML 片段：有正文逐行成段；无正文拼标题/字段/附件摘要。
 *
 *  images：附件 fileId → 压缩后的 data URL（由调用方异步取好再传进来，本函数保持纯函数）。
 *  拿得到就把图片**真的内嵌进正文**；此前只写一行「附件：图片1.png」，用户以为证照已经放进标书，
 *  实际正文里只有个文件名——审查自然报缺件（2026-08-06 用户反馈）。
 *  取图失败（不在 map 里）退回按文件名列出，不让整条插不进去。 */
export function libraryItemHtml(item: LibraryItem, images?: Map<string, string>): string {
  const atts = item.attachments ?? []
  const embedded = atts.filter((a) => isImageAttachment(a) && images?.get(a.fileId))
  const embeddedIds = new Set(embedded.map((a) => a.fileId))
  // alt 用附件名：喂给审查模型时 <img> 会被换成「［图片：营业执照.png］」，模型据此判断材料在不在
  const imgHtml = embedded
    .map((a) => `<p><img src="${images!.get(a.fileId)!}" alt="${escAttr(a.name)}" class="my-3 rounded-lg border border-border max-w-full" /></p>`)
    .join("")

  if (item.body) {
    const body = item.body
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${esc(line)}</p>`)
      .join("")
    return body + imgHtml
  }
  const parts: string[] = [`<strong>${esc(item.title)}</strong>`]
  if (item.meta) parts.push(esc(item.meta))
  if (item.fields?.length) parts.push(item.fields.map((f) => `${esc(f.label)}：${esc(f.value)}`).join("；"))
  const rest = atts.filter((a) => !embeddedIds.has(a.fileId))   // 已内嵌的不再重复列文件名
  if (rest.length) parts.push(`附件：${rest.map((a) => esc(a.name)).join("、")}`)
  return `<p>${parts.join("，")}。</p>` + imgHtml
}


/** 取回条目里图片附件的 data URL（供 libraryItemHtml 内嵌）。
 *  单张失败只跳过那一张——一张证照下不下来，不该让整条资料插不进去，退回按文件名列出即可。 */
export async function loadAttachmentImages(item: LibraryItem): Promise<Map<string, string>> {
  const imgs = (item.attachments ?? []).filter(isImageAttachment)
  const out = new Map<string, string>()
  await Promise.all(
    imgs.map(async (a) => {
      try {
        out.set(a.fileId, await imageUrlToDataUrl(await fileDownloadUrl(a.fileId)))
      } catch {
        /* 取不到就不内嵌，落回文件名 */
      }
    }),
  )
  return out
}
