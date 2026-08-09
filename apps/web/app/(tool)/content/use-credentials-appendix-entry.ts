"use client"

import { useState } from "react"
import { refreshCredentialsAppendix, type ExportPreview } from "@/lib/project"
import { SYS_CREDS_ID } from "@/lib/credentials-appendix"
import type { Chapter } from "./chapter-nav"

// 存量项目补挂「资格证明文件」附录入口（被删行为#1）：项目建于附录系统章节功能上线之前，
// 或 content 生成完之后用户才往资料库补传资质——两种情形下章节列表里都没有 sys-creds 章，
// 而 useCredentialsAppendix 的过期横条只在"当前打开的就是 sys-creds 章"时才可能出现，
// 章不存在就永远没有入口去把它变出来。刷新端点本就支持"没有旧章就新建"（见 App 侧
// credentials-chapter.ts 的 syncCredentialsOutline：无 sys-creds 章时会补进 outline），
// 这里只是把这条已有能力从"章内一键刷新"扩到"章都没有时也能一键生成"。

/** 系统章固定字面量（与 App 侧 SYS_CREDS_CHAPTER 同形，见 credentials-chapter.ts）：
 *  刷新端点只回 html，章节其余字段（no/title/group…）本就是常量，不必再拉一次 outline。 */
const SYS_CREDS_META = { id: SYS_CREDS_ID, no: "附录", title: "资格证明文件", system: true, sourced: false } as const

export function useCredentialsAppendixEntry(opts: {
  isReal: boolean
  preview: ExportPreview | null
  hasSysCredsChapter: boolean
  projectId: string | null
  /** 生成成功后把新章插进本地章节树（商务标分组，与 App 侧 SYS_CREDS_CHAPTER.group 一致）。 */
  onCreated: (chapter: Chapter) => void
}) {
  const { isReal, preview, hasSysCredsChapter, projectId, onCreated } = opts
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")

  // 显示条件：正文已生成、资料库确有资质图片、但当前章节列表还没有附录章。
  // preview 未到手（首屏未加载完）时按"暂不显示"处理，不误报——与 useCredentialsAppendix 的
  // stale 判定同一保守方向。
  const visible = isReal && !hasSysCredsChapter && !!preview && preview.credential_file_ids.length > 0

  async function create() {
    if (!projectId || creating) return
    setCreating(true)
    setError("")
    try {
      const { html } = await refreshCredentialsAppendix(projectId)
      onCreated({ ...SYS_CREDS_META, html, items: [] })
    } catch {
      setError("生成失败，请重试")
    } finally {
      setCreating(false)
    }
  }

  return { visible, creating, error, create }
}
