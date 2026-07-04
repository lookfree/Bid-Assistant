import type React from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/admin/app-sidebar"
import { AdminHeader } from "@/components/admin/admin-header"
import { RequireAdmin } from "@/components/RequireAdmin"

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // spec309：整个运营后台受 admin 登录守卫（未登录跳 /login）；各功能页数据接线在 spec310。
  return (
    <RequireAdmin>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AdminHeader />
          <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </RequireAdmin>
  )
}
