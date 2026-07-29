"use client"

import { type LibraryItem } from "@/lib/library"

/** 资料库存的是纯文本，拼进 HTML 前必须转义：「响应时间 < 2 小时」「A&B 公司」这类内容
 *  直接拼会被浏览器当标签/实体解析，轻则显示错乱，重则从 '<' 起后半句整段被吞（静默丢内容）。 */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** 资料条目 → 可插入的 HTML 片段：有正文逐行成段；无正文拼标题/字段/附件摘要。 */
export function libraryItemHtml(item: LibraryItem): string {
  if (item.body) {
    return item.body
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${esc(line)}</p>`)
      .join("")
  }
  const parts: string[] = [`<strong>${esc(item.title)}</strong>`]
  if (item.meta) parts.push(esc(item.meta))
  if (item.fields?.length) parts.push(item.fields.map((f) => `${esc(f.label)}：${esc(f.value)}`).join("；"))
  if (item.attachments?.length) parts.push(`附件：${item.attachments.map((a) => esc(a.name)).join("、")}`)
  return `<p>${parts.join("，")}。</p>`
}
