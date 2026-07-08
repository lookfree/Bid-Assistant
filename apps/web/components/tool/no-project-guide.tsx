"use client"

import Link from "next/link"
import { ArrowRight, PlayCircle, Upload } from "lucide-react"

// 演示视频入口：未配置链接时整个隐藏（视频上线后配置 env 才显示）
const DEMO_VIDEO_URL = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL

/** 非 demo 且无进行中项目时的引导卡片（四个工具页共用）：只指向上传，不渲染任何示例内容。 */
export function NoProjectGuide() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
          <Upload className="size-7 text-primary" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-foreground">还没有进行中的项目</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          先上传招标文件开始，AI 将自动读标并生成对齐评分点的完整标书
        </p>
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Link
            href="/upload"
            className="inline-flex items-center gap-1.5 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            上传招标文件
            <ArrowRight className="size-4" />
          </Link>
          {DEMO_VIDEO_URL && (
            <button
              type="button"
              onClick={() => window.open(DEMO_VIDEO_URL, "_blank")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <PlayCircle className="size-4 text-primary" />
              观看演示视频
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
