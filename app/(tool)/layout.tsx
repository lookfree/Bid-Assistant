import type React from "react"
import Link from "next/link"
import { Sparkles, LogIn, User } from "lucide-react"
import { AppSidebar } from "@/components/tool/app-sidebar"
import { MobileNav } from "@/components/tool/mobile-nav"
import { PaywallProvider } from "@/components/paywall"

export default function ToolLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <PaywallProvider>
      <div className="flex min-h-screen bg-background">
        <AppSidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶栏 */}
          <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6">
            {/* 移动端：汉堡菜单 + Logo（桌面端由侧边栏展示） */}
            <div className="flex items-center gap-2 lg:hidden">
              <MobileNav />
              <Link href="/" className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-xl gradient-brand">
                  <Sparkles className="size-4 text-white" />
                </span>
                <span className="text-[15px] font-bold tracking-tight text-foreground">智启元 · 投标助手</span>
              </Link>
            </div>
            <div className="hidden lg:block" />

            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <LogIn className="size-4" />
                <span className="hidden sm:inline">立即登录</span>
              </Link>
              <Link
                href="/membership"
                className="flex size-9 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/70"
                aria-label="个人中心"
              >
                <User className="size-4" />
              </Link>
            </div>
          </header>

          <main className="flex-1">{children}</main>
        </div>
      </div>
    </PaywallProvider>
  )
}
