"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, X } from "lucide-react"
import {
  BidTextUnavailableError,
  fetchBidChapters,
  locateFinding,
  paragraphsOf,
  type BidChapter,
} from "@/lib/bid-chapters"

/** 线下标书只读正文弹层（#97②）：审查报告点一条风险，在这里看到标书里对应的地方。
 *
 *  系统生成的标书能跳，是因为正文就在页面里；线下上传的标书系统里没有可编辑正文，
 *  报告卡片以前点哪儿都没反应。正文按需向后端要（不落库、不计费），只读、不可编辑——
 *  用户手里的原件才是权威，这里只用来核对。 */
export function BidTextDialog({
  projectId,
  chapterTitle,
  anchorText,
  onClose,
}: {
  projectId: string
  chapterTitle: string
  anchorText: string
  onClose: () => void
}) {
  const [chapters, setChapters] = useState<BidChapter[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hitRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => {
    let alive = true
    fetchBidChapters(projectId)
      .then((r) => alive && setChapters(r.chapters))
      .catch((e) => {
        if (!alive) return
        // 「给不出正文」与「服务故障」要分开说：前者重试多少次都一样，别让用户白点
        setError(e instanceof BidTextUnavailableError
          ? "这份标书解析不出可展示的正文（可能是加密、损坏，或整份都是扫描件）"
          : "标书原文加载失败，请稍后重试")
      })
    return () => { alive = false }
  }, [projectId])

  const hit = chapters ? locateFinding(chapters, chapterTitle, anchorText) : null
  // 命中段渲染出来之后再滚：ref 是渲染时挂上的，同步滚拿到的是 null
  useEffect(() => {
    if (hit) requestAnimationFrame(() => hitRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }))
  }, [hit])

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!chapters && !error && (
            <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在解析标书原文…（大文件需要几十秒）
            </p>
          )}
          {error && <p className="py-10 text-sm text-destructive">{error}</p>}
          {/* 定位不到就明说，不静悄悄停在开头——那会让用户以为问题出在标书第一章 */}
          {chapters && !hit && (
            <p className="mb-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
              未能在标书里定位到这条问题指的位置（审查给的章节名或摘录可能是转述），以下为全文。
            </p>
          )}
          {chapters?.map((c, ci) => (
            <section key={`${c.title}-${ci}`} className="mb-5">
              <h3 className={`text-sm font-semibold ${hit?.chapterIndex === ci ? "text-primary" : "text-foreground"}`}>
                {c.title}
              </h3>
              <div className="mt-2 space-y-2">
                {paragraphsOf(c.text).map((p, pi) => {
                  const isHit = hit?.chapterIndex === ci && hit.paragraphIndex === pi
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
                {paragraphsOf(c.text).length === 0 && (
                  <p className="text-xs text-muted-foreground">（本章未解析出文字，可能是扫描件或图片页）</p>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
