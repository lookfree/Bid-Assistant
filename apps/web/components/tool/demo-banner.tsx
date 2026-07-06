"use client"

import Link from "next/link"
import { ArrowRight, Sparkles } from "lucide-react"

/** outline/content/present 三页的示例模式横幅（read 页保留原有完整版横幅）。 */
export function DemoBanner() {
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="inline-flex items-center gap-2 text-xs font-medium text-primary sm:text-sm">
        <Sparkles className="size-4" />
        示例体验中 · 数据为演示样例 · 不消耗积分
      </p>
      <Link
        href="/upload"
        className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-card/70"
      >
        上传我的招标文件
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  )
}
