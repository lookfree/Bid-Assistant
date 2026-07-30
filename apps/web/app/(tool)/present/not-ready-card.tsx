"use client"

import Link from "next/link"
import { Presentation } from "lucide-react"
import { OtherBidSection } from "./empty-state"

/** 当前项目还不能述标：**停在生成卡的位置**说清楚差哪一步，并留换标书的入口。
 *  原来这种情况直接把整页换成选择页——用户从菜单点进来看到的是个完全不同的页面
 *  （反馈：莫名其妙又出现这种页面）。此状态下不渲染任何计费按钮：后端也不放行，亮出来点了就是 409。 */
export function NotReadyCard({ projectName, gap }: { projectName: string; gap: { href: string; label: string } }) {
  return (
    <div className="flex justify-center p-4">
      <div className="w-full max-w-xl py-8">
        <div className="rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl gradient-brand-soft">
            <Presentation className="size-7 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-foreground">一键生成述标大纲</h2>
          {/* 只说当前卡在哪一步，不承诺"回来即可一键生成"——gap 是项目的当前步，
              离述标可能还隔着提纲、正文好几步（且每步都要花钱），说满了就是骗人（评审）。 */}
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            述标取的是标书正文（技术标 + 商务标）。当前项目「{projectName}」的进度还在「{gap.label}」，
            走完正文生成后回到本页即可生成述标。
          </p>
          <div className="mt-5 flex justify-center">
            <Link
              href={gap.href}
              className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              前往{gap.label}
            </Link>
          </div>
          <p className="mt-5 text-xs text-muted-foreground">或者述标别的标书：</p>
          <OtherBidSection />
        </div>
      </div>
    </div>
  )
}
