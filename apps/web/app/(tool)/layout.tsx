import type React from "react"
import Link from "next/link"
import { Sparkles } from "lucide-react"
import { HeaderAuth } from "@/components/tool/header-auth"
import { AppSidebar } from "@/components/tool/app-sidebar"
import { MobileNav } from "@/components/tool/mobile-nav"
import { PaywallProvider } from "@/components/paywall"
import { RequireAuth } from "@/components/auth/require-auth"

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

            <HeaderAuth />
          </header>

          <main className="flex-1">
            <RequireAuth>{children}</RequireAuth>
          </main>
        </div>
      </div>
    </PaywallProvider>
  )
}
