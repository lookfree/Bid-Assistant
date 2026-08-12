"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, X } from "lucide-react"
import {
  BidTextUnavailableError,
  NoBidFileError,
  fetchBidChapters,
  locateFinding,
  type BidChapter,
  type BidLocation,
} from "@/lib/bid-chapters"

/** 线下标书只读正文弹层（#97②）：审查报告点一条风险，在这里看到标书里对应的地方。
 *
 *  系统生成的标书能跳，是因为正文就在页面里；线下上传的标书系统里没有可编辑正文，
 *  报告卡片以前点哪儿都没反应。正文按需向后端要（不落库、不计费），只读、不可编辑——
 *  用户手里的原件才是权威，这里只用来核对。 */
export function BidTextDialog({
  projectId,
  targetId,
  chapterTitle,
  anchorText,
  onClose,
}: {
  projectId: string
  targetId: string
  chapterTitle: string
  anchorText: string
  onClose: () => void
}) {
  const [data, setData] = useState<{ chapters: BidChapter[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hitRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => {
    let alive = true
    fetchBidChapters(projectId)
      .then((r) => alive && setData(r))
      .catch((e) => {
        if (!alive) return
        // 三种情况说辞不同：没传过标书 / 传了但解析不出 / 服务故障。
        // 混成一句「解析不出」会把「你压根没传」说成「你的文件坏了」，用户会跑去重导标书。
        if (e instanceof NoBidFileError) setError("这个项目没有线下上传的投标文件")
        else if (e instanceof BidTextUnavailableError) setError("这份标书解析不出可展示的正文（可能是加密、损坏，或整份都是扫描件）")
        else setError("标书原文加载失败，请稍后重试")
      })
    return () => { alive = false }
  }, [projectId])

  // useMemo 不是为了省算力，是为了**对象身份稳定**：locateFinding 每次渲染都会造一个新对象，
  // 拿它当 effect 依赖的话，父页轮询触发的每次重渲都会把用户滚回高亮处（读到第五章被拽回来）。
  const chapters = data?.chapters ?? []
  const hit = useMemo(
    () => (chapters.length ? locateFinding(chapters, targetId, chapterTitle, anchorText) : null),
    [chapters, targetId, chapterTitle, anchorText],
  )
  useEffect(() => {
    if (hit) requestAnimationFrame(() => hitRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }))
  }, [hit])

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <DialogHeader chapterTitle={chapterTitle} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!data && !error && (
            <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在解析标书原文…（大文件需要几十秒）
            </p>
          )}
          {error && <p className="py-10 text-sm text-destructive">{error}</p>}
          <Notices located={!!hit} hasData={!!data} truncated={!!data?.truncated} />
          {chapters.map((c, ci) => (
            <ChapterBlock key={c.sec} chapter={c} index={ci} hit={hit} hitRef={hitRef} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DialogHeader({ chapterTitle, onClose }: { chapterTitle: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-foreground">标书原文</h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {chapterTitle ? `定位到：${chapterTitle}` : "只读视图，供核对用"}
        </p>
      </div>
      <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="size-5" />
      </button>
    </div>
  )
}

/** 定位不到 / 正文被截断都要明说：静悄悄停在开头，用户会以为问题出在标书第一章；
 *  截断了却不说，用户会以为标书就这么点内容。 */
function Notices({ located, hasData, truncated }: { located: boolean; hasData: boolean; truncated: boolean }) {
  if (!hasData) return null
  return (
    <>
      {!located && (
        <p className="mb-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
          未能在标书里定位到这条问题指的位置（审查给的章节或摘录可能是转述），以下为全文。
        </p>
      )}
      {truncated && (
        <p className="mb-3 rounded-xl border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          标书较长，部分章节正文已截断展示；完整内容请看你手里的原件。
        </p>
      )}
    </>
  )
}

function ChapterBlock({
  chapter,
  index,
  hit,
  hitRef,
}: {
  chapter: BidChapter
  index: number
  hit: BidLocation | null
  hitRef: React.RefObject<HTMLParagraphElement | null>
}) {
  const active = hit?.chapterIndex === index
  return (
    <section className="mb-5">
      <h3 className={`text-sm font-semibold ${active ? "text-primary" : "text-foreground"}`}>
        {chapter.title || "（未命名章节）"}
      </h3>
      <div className="mt-2 space-y-2">
        {chapter.paragraphs.map((p, pi) => {
          const isHit = active && hit.paragraphIndex === pi
          return (
            <p
              key={pi}
              ref={isHit ? hitRef : undefined}
              className={`text-xs leading-relaxed ${isHit ? "rounded-lg bg-warning/20 px-2 py-1 text-foreground" : "text-muted-foreground"}`}
            >
              {p}
            </p>
          )
        })}
        {chapter.paragraphs.length === 0 && (
          <p className="text-xs text-muted-foreground">（本章未解析出文字，可能是扫描件或图片页）</p>
        )}
      </div>
    </section>
  )
}
