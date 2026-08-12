"use client"

import { api } from "./api"
import { ApiError } from "./api-client"
import { blockMatchesAnchor } from "./anchor"

// 线下标书的只读正文（#97②）：审查报告点一条风险，跳到标书里对应的地方。
//
// 系统生成的标书能跳，是因为正文就在页面里；线下上传的标书系统里没有可编辑正文，
// 报告卡片以前点哪儿都没反应。现在按需向后端要一次分章正文（不落库、不计费），
// 在弹层里展示并定位。

export type BidChapter = { title: string; text: string }

/** 后端明确说「这份标书给不出可跳转的正文」（加密/损坏/纯扫描件），与服务故障区分开。 */
export class BidTextUnavailableError extends Error {}

/** 取分章正文。项目没有线下投标文件（409）也归为「没有可展示的原文」。 */
export async function fetchBidChapters(projectId: string): Promise<{ chapters: BidChapter[]; truncated: boolean }> {
  try {
    return await api.request(`/api/projects/${projectId}/bid-chapters`)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 422 || e.status === 409)) throw new BidTextUnavailableError()
    throw e
  }
}

/** 一章正文切成可定位的段落。空行分段——解析出来的正文就是按行来的。 */
export function paragraphsOf(text: string): string[] {
  return (text || "").split(/\n+/).map((p) => p.trim()).filter(Boolean)
}

export type BidLocation = { chapterIndex: number; paragraphIndex: number }

/** 在分章正文里找这条风险指的位置。

 *  先按**章标题**收窄，再在章内按 anchorText 找段落——审查给的 anchorText 是模型从标书里
 *  「原样摘抄」的一小段，实际总有出入，所以复用 lib/anchor 那套前缀匹配而不是全等。
 *  章定位得到、段落定位不到 → 落到该章开头（章是可信的，段落只是锦上添花）；
 *  **章也定位不到就返回 null**，不落到第一章——那会让用户以为问题出在标书开头。 */
export function locateFinding(
  chapters: BidChapter[],
  chapterTitle: string,
  anchorText: string,
): BidLocation | null {
  const title = (chapterTitle || "").trim()
  let chapterIndex = title ? chapters.findIndex((c) => c.title.includes(title) || title.includes(c.title)) : -1
  if (chapterIndex < 0 && anchorText.trim()) {
    // 章标题对不上时退而求其次：全书找摘抄段（模型有时给的是分册名而非章名）
    chapterIndex = chapters.findIndex((c) => paragraphsOf(c.text).some((p) => blockMatchesAnchor(p, anchorText)))
  }
  if (chapterIndex < 0) return null
  const paras = paragraphsOf(chapters[chapterIndex]!.text)
  const paragraphIndex = anchorText.trim()
    ? Math.max(0, paras.findIndex((p) => blockMatchesAnchor(p, anchorText)))
    : 0
  return { chapterIndex, paragraphIndex }
}
