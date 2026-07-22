"use client"

import { type LibraryItem } from "@/lib/library"

/** 资料条目 → 可插入的 HTML 片段：有正文逐行成段；无正文拼标题/字段/附件摘要。 */
export function libraryItemHtml(item: LibraryItem): string {
  if (item.body) {
    return item.body
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${line}</p>`)
      .join("")
  }
  const parts: string[] = [`<strong>${item.title}</strong>`]
  if (item.meta) parts.push(item.meta)
  if (item.fields?.length) parts.push(item.fields.map((f) => `${f.label}：${f.value}`).join("；"))
  if (item.attachments?.length) parts.push(`附件：${item.attachments.map((a) => a.name).join("、")}`)
  return `<p>${parts.join("，")}。</p>`
}
