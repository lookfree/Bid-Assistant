"use client"

import Link from "next/link"
import { ListChecks, Lock, Presentation } from "lucide-react"
import type { Slide, SlideStyle } from "@/lib/present"

/* ============== 幻灯片预览画布 ============== */
export function SlidePreview({ slide, style }: { slide: Slide; style: SlideStyle }) {
  if (slide.kind === "cover" || slide.kind === "end") {
    return (
      <div className={`flex aspect-video flex-col items-center justify-center rounded-2xl ${style.coverBg} p-8 text-center text-white shadow-lg`}>
        <Presentation className="size-10 opacity-90" />
        <h2 className="mt-4 text-2xl font-bold text-balance">{slide.title}</h2>
        <div className="mt-4 flex flex-col gap-1 text-sm text-white/85">
          {slide.bullets.map((b, i) => (
            <span key={i}>{b}</span>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="aspect-video overflow-hidden rounded-2xl border border-border bg-card p-7 shadow-lg">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}>
        <ListChecks className="size-3" />
        {slide.scoring}
      </span>
      <div className="mt-3 flex items-center gap-2.5">
        <span className={`h-6 w-1 rounded-full ${style.bar}`} />
        <h2 className="text-xl font-bold text-foreground text-balance">{slide.title}</h2>
      </div>
      <ul className="mt-5 flex flex-col gap-2.5">
        {slide.bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground">
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ============== 付费模糊块 ============== */
export function LockedBlock({ text, rows }: { text: string; rows: number }) {
  return (
    <div className="relative mt-1.5">
      <p
        className="select-none overflow-hidden rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground blur-[4px]"
        style={{ maxHeight: `${rows * 1.6}rem` }}
        aria-hidden
      >
        {text}
      </p>
      <div className="absolute inset-0 flex items-center justify-center">
        <Link
          href="/membership"
          className="inline-flex items-center gap-1.5 rounded-lg gradient-brand px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Lock className="size-3.5" />
          解锁完整演讲稿与问答
        </Link>
      </div>
    </div>
  )
}
