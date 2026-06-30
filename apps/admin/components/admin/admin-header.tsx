"use client"

import { usePathname } from "next/navigation"
import { LogOut, Settings, UserCog, ChevronDown } from "lucide-react"
import { toast } from "sonner"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const titles: Record<string, string> = {
  "/": "概览看板",
  "/users": "用户与会员",
  "/orders": "订单与对账",
  "/ledger": "积分账本审计",
  "/plans": "套餐与积分口径配置",
  "/system": "系统与权限",
}

export function AdminHeader() {
  const pathname = usePathname()
  const key =
    pathname === "/"
      ? "/"
      : Object.keys(titles).find((k) => k !== "/" && pathname.startsWith(k)) ??
        "/"
  const title = titles[key]

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-sm md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-5" />
      <div className="flex flex-col">
        <h1 className="text-base font-semibold leading-tight text-foreground">
          {title}
        </h1>
        <span className="text-xs text-muted-foreground">智启元 · 内部运营</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Badge variant="secondary" className="hidden sm:inline-flex">
          生产环境
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="h-10 gap-2 px-2">
                <Avatar className="size-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    顾
                  </AvatarFallback>
                </Avatar>
                <div className="hidden text-left leading-tight sm:block">
                  <div className="text-sm font-medium">顾屿安</div>
                  <div className="text-xs text-muted-foreground">
                    超级管理员
                  </div>
                </div>
                <ChevronDown className="size-4 text-muted-foreground" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">顾屿安</span>
                <span className="text-xs font-normal text-muted-foreground">
                  guyuan@zhiqiyuan.com
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => toast.info("打开账号设置")}>
                <UserCog />
                账号设置
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => toast.info("打开系统偏好")}>
                <Settings />
                系统偏好
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => toast.success("已退出登录")}
            >
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
