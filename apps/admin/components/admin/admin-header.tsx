"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { LogOut, ChevronDown } from "lucide-react"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { adminApi, type AdminMe } from "@/lib/admin-api"
import { adminTokenStore } from "@/lib/admin-token-store"

const titles: Record<string, string> = {
  "/": "概览看板",
  "/users": "用户与会员",
  "/orders": "订单与对账",
  "/ledger": "积分账本审计",
  "/plans": "套餐与积分口径配置",
  "/system": "系统与权限",
}

// 角色 → 中文（与 system-client 保持一致）。
const ROLE_LABEL: Record<string, string> = {
  superadmin: "超级管理员",
  finance: "财务",
  ops: "运营",
  support: "客服",
}

export function AdminHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const key = pathname === "/" ? "/" : Object.keys(titles).find((k) => k !== "/" && pathname.startsWith(k)) ?? "/"
  const title = titles[key]

  // 真实登录管理员（此前 header 写死「顾屿安」假数据）；me 由 RequireAdmin 已校验,这里再取一次展示。
  const [me, setMe] = useState<AdminMe | null>(null)
  const [meFailed, setMeFailed] = useState(false)
  useEffect(() => {
    let alive = true
    adminApi.me().then((r) => alive && setMe(r.admin)).catch(() => alive && setMeFailed(true))
    return () => {
      alive = false
    }
  }, [])

  // 自包含下拉：原 base-ui Menu 版本组件与当前 @base-ui/react 打开即崩（error #31）,改用
  // 轻量受控面板 + 点击外部关闭,零第三方菜单依赖,不再崩溃。
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onEsc)
    }
  }, [open])

  const username = me?.username ?? "—"
  const roleLabel = me ? (ROLE_LABEL[me.role] ?? me.role) : meFailed ? "—" : "加载中…"
  const initial = username.slice(0, 1).toUpperCase()

  async function logout() {
    setOpen(false)
    try {
      await adminApi.logout()
    } catch {
      // 忽略：即便服务端登出失败,也要本地清票据并跳登录,避免卡在半登录态
    }
    adminTokenStore.clear()
    router.replace("/login")
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-sm md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-5" />
      <div className="flex flex-col">
        <h1 className="text-base font-semibold leading-tight text-foreground">{title}</h1>
        <span className="text-xs text-muted-foreground">智启元 · 内部运营</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Badge variant="secondary" className="hidden sm:inline-flex">
          生产环境
        </Badge>
        <div ref={wrapRef} className="relative">
          <Button variant="ghost" className="h-10 gap-2 px-2" onClick={() => setOpen((v) => !v)}>
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">{initial}</AvatarFallback>
            </Avatar>
            <div className="hidden text-left leading-tight sm:block">
              <div className="text-sm font-medium">{username}</div>
              <div className="text-xs text-muted-foreground">{roleLabel}</div>
            </div>
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
          {open && (
            <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {/* 账号信息（原「查看信息」跳转报错 → 改为就地展示真实身份,不再跳空路由） */}
              <div className="flex flex-col gap-1 px-2.5 py-2">
                <span className="text-sm font-medium">{username}</span>
                <span className="text-xs text-muted-foreground">角色：{roleLabel}</span>
                {me?.status && <span className="text-xs text-muted-foreground">状态：{me.status === "active" ? "正常" : me.status}</span>}
              </div>
              <Separator className="my-1" />
              <button
                onClick={() => void logout()}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <LogOut className="size-4" />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
