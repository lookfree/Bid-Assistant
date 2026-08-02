"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Users,
  Receipt,
  BookText,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  BrainCircuit,
  MessageSquare,
  FileText,
  Tags,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { usePermissions, visibleNav } from "@/lib/admin-perms"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

// 菜单 → 权限点绑定（2026-08-02 可编辑 RBAC）：perm 缺省=登录即可见（概览）。
// 角色没有对应权限点的菜单**直接不渲染**;权限集来自 /me（服务端矩阵）,前端不复制矩阵。
const nav = [
  { title: "概览看板", url: "/", icon: LayoutDashboard },
  { title: "用户与会员", url: "/users", icon: Users, perm: "user.read" },
  { title: "订单与对账", url: "/orders", icon: Receipt, perm: "order.read" },
  { title: "积分账本审计", url: "/ledger", icon: BookText, perm: "ledger.read" },
  { title: "套餐与积分口径", url: "/plans", icon: SlidersHorizontal, perm: "plan.write" },
  { title: "模型管理", url: "/models", icon: BrainCircuit, perm: "config.write" },
  { title: "反馈工单", url: "/feedback", icon: MessageSquare, perm: "feedback.read" },
  { title: "发票管理", url: "/invoices", icon: FileText, perm: "invoice.write" },
  { title: "标书分类纠偏", url: "/bid-categories", icon: Tags, perm: "category.read" },
  { title: "系统与权限", url: "/system", icon: ShieldCheck, perm: "admin.manage" },
]

export function AppSidebar() {
  const pathname = usePathname()
  const perms = usePermissions()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <div className="bg-gradient-brand flex aspect-square size-8 items-center justify-center rounded-lg text-primary-foreground">
                <Sparkles className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">智启元</span>
                <span className="truncate text-xs text-muted-foreground">
                  运营管理后台
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>运营模块</SidebarGroupLabel>
          <SidebarMenu>
            {visibleNav(nav, perms).map((item) => {
              const active =
                item.url === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.url)
              return (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={item.title}
                    className={cn(
                      "relative font-medium",
                      active &&
                        "before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-sidebar-primary data-[active=true]:font-semibold",
                    )}
                    render={
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    }
                  />
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="rounded-md bg-sidebar-accent px-3 py-2 text-xs text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden">
          内部系统 · v1.0.0
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
