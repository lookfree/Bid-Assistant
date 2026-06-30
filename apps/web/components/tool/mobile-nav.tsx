"use client"

import { useState } from "react"
import { Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { SidebarContent } from "@/components/tool/app-sidebar"

/**
 * 移动端导航：顶栏汉堡按钮 + 左侧滑出抽屉。
 * 复用 SidebarContent（分组导航与积分卡）；点遮罩、按 Esc、点导航项均可关闭。
 */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  useEscapeClose(close, open)

  return (
    <div className="lg:hidden">
      <button
        onClick={() => setOpen(true)}
        aria-label="打开导航菜单"
        aria-expanded={open}
        className="flex size-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-secondary"
      >
        <Menu className="size-5" />
      </button>

      {/* 抽屉 */}
      <div className={cn("fixed inset-0 z-50", open ? "" : "pointer-events-none")} aria-hidden={!open}>
        {/* 遮罩 */}
        <div
          onClick={close}
          className={cn(
            "absolute inset-0 bg-foreground/40 backdrop-blur-sm transition-opacity duration-300",
            open ? "opacity-100" : "opacity-0",
          )}
          aria-hidden
        />
        {/* 面板 */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="导航菜单"
          className={cn(
            "absolute left-0 top-0 flex h-full w-72 max-w-[82%] flex-col border-r border-border bg-card shadow-2xl transition-transform duration-300",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <button
            onClick={close}
            aria-label="关闭导航菜单"
            className="absolute right-3 top-4 z-10 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-5" />
          </button>
          <SidebarContent onNavigate={close} />
        </div>
      </div>
    </div>
  )
}
