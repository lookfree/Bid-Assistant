"use client"

import { api } from "./api"
import { ApiError } from "./api-client"
import { blockMatchesAnchor } from "./anchor"

// 线下标书的只读正文（#97②）：审查报告点一条风险，跳到标书里对应的地方。
//
// 系统生成的标书能跳，是因为正文就在页面里；线下上传的标书系统里没有可编辑正文，
// 报告卡片以前点哪儿都没反应。现在按需向后端要一次分章正文（不落库、不计费），
// 在弹层里展示并定位。

/** 一章：sec = 节 id（审查结论 target_id 原样照抄的就是它）、title 标题、paragraphs 已切好的段。 */
export type BidChapter = { sec: string; title: string; paragraphs: string[] }

/** 后端明确说「这份标书给不出可跳转的正文」（加密/损坏/纯扫描件），与服务故障区分开。 */
export class BidTextUnavailableError extends Error {}
/** 这个项目压根没有线下投标文件（409）——与「解析不出」不是一回事，说辞不能混。 */
export class NoBidFileError extends Error {}

// 同一份标书在一次会话里会被反复点开（一份报告 20 条风险就是 20 次），而每次都要回源
// 从 MinIO 取件重解析（几百页可跑数十秒）。按项目缓存一次，关掉弹层再开不再等。
const cache = new Map<string, { chapters: BidChapter[]; truncated: boolean }>()

export async function fetchBidChapters(projectId: string): Promise<{ chapters: BidChapter[]; truncated: boolean }> {
  const hit = cache.get(projectId)
  if (hit) return hit
  try {
    const got = await api.request<{ chapters: BidChapter[]; truncated: boolean }>(
      `/api/projects/${projectId}/bid-chapters`)
    cache.set(projectId, got)
    return got
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new NoBidFileError()
    if (e instanceof ApiError && e.status === 422) throw new BidTextUnavailableError()
    throw e
  }
}

export type BidLocation = { chapterIndex: number; paragraphIndex: number }

/** 在分章正文里找这条风险指的位置。

 *  **先按 sec 精确命中**：审查契约要求 target_id 原样照抄材料里的节 id（schemas
 *  RiskFinding.target_id），拿它做字典式定位，比按模型自己写的章名模糊匹配可靠得多——
 *  「第一章 商务响应」与「商务响应（第一册）」这种出入，模糊匹配就废了。
 *  章名与摘抄段是它对不上时的两条退路。
 *  章内段落用 anchorText 前缀匹配（模型是「原样摘抄」，实际总有出入，见 lib/anchor）。
 *  **章定位不到就返回 null**，不落到第一章——那会让用户以为问题出在标书开头。 */
export function locateFinding(
  chapters: BidChapter[],
  targetId: string,
  chapterTitle: string,
  anchorText: string,
): BidLocation | null {
  const title = (chapterTitle || "").trim()
  const anchor = (anchorText || "").trim()
  let chapterIndex = targetId ? chapters.findIndex((c) => c.sec === targetId) : -1
  if (chapterIndex < 0 && title) {
    chapterIndex = chapters.findIndex((c) => c.title.includes(title) || title.includes(c.title))
  }
  if (chapterIndex < 0 && anchor) {
    chapterIndex = chapters.findIndex((c) => c.paragraphs.some((p) => blockMatchesAnchor(p, anchor)))
  }
  if (chapterIndex < 0) return null
  const paras = chapters[chapterIndex]!.paragraphs
  const paragraphIndex = anchor ? Math.max(0, paras.findIndex((p) => blockMatchesAnchor(p, anchor))) : 0
  return { chapterIndex, paragraphIndex }
}
