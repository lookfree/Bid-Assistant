"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"
import {
  Sparkles,
  FilePlus2,
  FileSearch,
  ListTree,
  PenLine,
  ShieldCheck,
  Presentation,
  FolderClosed,
  Library,
  Crown,
  Coins,
  ArrowRight,
  MessageSquareText,
  Gift,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useMembership } from "@/lib/use-membership"

type NavItem = {
  href: string
  label: string
  icon: React.ElementType
  /** 额外匹配的路径，用于高亮 */
  match?: string[]
}

const groups: { title: string; items: NavItem[] }[] = [
  {
    title: "智能编标",
    items: [
      { href: "/upload", label: "新建标书", icon: FilePlus2 },
      { href: "/read", label: "招标解读", icon: FileSearch },
      { href: "/outline", label: "提纲生成", icon: ListTree },
      { href: "/content", label: "标书生成", icon: PenLine },
      { href: "/risk", label: "标书审查", icon: ShieldCheck },
      { href: "/present", label: "述标演示", icon: Presentation },
    ],
  },
  {
    title: "我的",
    items: [
      { href: "/projects", label: "我的标书", icon: FolderClosed },
      { href: "/library", label: "我的资料库", icon: Library },
      { href: "/membership", label: "会员中心", icon: Crown },
      { href: "/referral", label: "邀请好友", icon: Gift },
      { href: "/feedback", label: "帮助与反馈", icon: MessageSquareText },
    ],
  },
]

/**
 * 侧边栏内容：Logo + 分组导航 + 积分卡。
 * 桌面端固定侧栏与移动端抽屉共用，onNavigate 用于点击导航项后关闭抽屉。
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  /* 真实积分余额（GET /api/membership）；加载中显示占位 */
  const { balance, loading: balanceLoading, reload } = useMembership()

  // (tool) 布局跨路由常驻不重挂载，useMembership 的首次拉取不会随导航重跑——
  // 路由切换时补一次刷新（跳过首次挂载；共享 store 并发合并，多处触发也只打一次接口）。
  // credits:refresh 事件已由 useMembership 模块级统一监听（全站积分单一来源），这里不再重复订阅。
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    reload()
  }, [pathname, reload])

  return (
    <>
      {/* Logo */}
      <Link href="/" onClick={onNavigate} className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex size-9 items-center justify-center rounded-xl gradient-brand">
          <Sparkles className="size-5 text-white" />
        </span>
        <span className="text-base font-bold tracking-tight text-foreground">智启元 · 投标助手</span>
      </Link>

      {/* 导航 */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {groups.map((group) => (
          <div key={group.title} className="mb-4">
            <p className="px-3 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">{group.title}</p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active =
                  pathname === item.href || (item.match?.some((m) => pathname.startsWith(m)) ?? false)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "gradient-brand-soft text-primary"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                      )}
                      <item.icon className="size-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* 底部：积分余额与充值 */}
      <div className="border-t border-border p-3">
        <div className="rounded-xl gradient-brand-soft p-3">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="size-3.5 text-[oklch(0.55_0.13_75)]" />
              剩余积分
            </span>
            <span className="text-sm font-bold text-foreground">{balanceLoading ? "…" : balance.toLocaleString()}</span>
          </div>
          <Link
            href="/membership"
            onClick={onNavigate}
            className="mt-2.5 flex items-center justify-center gap-1.5 rounded-lg gradient-brand px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            去充值
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </>
  )
}

export function AppSidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
      <SidebarContent />
    </aside>
  )
}
