"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Search, ShieldCheck } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { TablePagination } from "@/components/admin/table-pagination"
import { adminApi, type ApiAdmin, type ApiAuditLog } from "@/lib/admin-api"

// 角色 → 中文标签。真实角色枚举固定为 superadmin/finance/ops/support（apps/api AdminRole）。
const ROLE_LABEL: Record<string, string> = {
  superadmin: "超级管理员",
  ops: "运营",
  finance: "财务",
  support: "客服",
}
const ROLE_ORDER = ["superadmin", "finance", "ops", "support"]

export function SystemClient() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">系统与权限</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          管理运营账号、角色权限(RBAC)与敏感操作审计日志。
        </p>
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">运营账号</TabsTrigger>
          <TabsTrigger value="roles">角色权限</TabsTrigger>
          <TabsTrigger value="audit">操作审计日志</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="mt-4">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AccountsTab() {
  const [accounts, setAccounts] = useState<ApiAdmin[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await adminApi.system.admins({ pageSize: 100 })
        if (alive) setAccounts(res.items)
      } catch {
        if (alive) toast.error("加载运营账号失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>运营账号</CardTitle>
        <CardDescription>共 {accounts.length} 个内部账号。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((op) => (
              <TableRow key={op.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-accent text-accent-foreground text-xs">
                        {op.username.slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium text-foreground">
                      {op.username}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-normal">
                    {ROLE_LABEL[op.role] ?? op.role}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {op.createdAt?.slice(0, 10) ?? "-"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      op.status === "active"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-border bg-muted text-muted-foreground"
                    }
                  >
                    {op.status === "active" ? "启用" : "已停用"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            ) : accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  暂无运营账号
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RolesTab() {
  const [permissions, setPermissions] = useState<string[]>([])
  const [roles, setRoles] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await adminApi.system.rbac()
        if (alive) {
          setPermissions(res.permissions)
          setRoles(res.roles)
        }
      } catch {
        if (alive) toast.error("加载角色权限失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  // 列顺序固定为 superadmin/finance/ops/support；只渲染真实返回里存在的角色。
  const roleKeys = useMemo(() => ROLE_ORDER.filter((r) => r in roles), [roles])

  return (
    <Card>
      <CardHeader>
        <CardTitle>角色权限矩阵 (RBAC)</CardTitle>
        <CardDescription>
          只读展示各角色的真实权限。权限由后端把关，此矩阵没有可持久化的开关，勾选状态不可编辑。
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-44">权限项</TableHead>
              {roleKeys.map((r) => (
                <TableHead key={r} className="text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span className="font-medium text-foreground">
                      {ROLE_LABEL[r] ?? r}
                    </span>
                    {r === "superadmin" && (
                      <ShieldCheck className="size-3.5 text-primary" />
                    )}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {permissions.map((perm) => (
              <TableRow key={perm}>
                <TableCell className="text-sm font-medium text-foreground">
                  {perm}
                </TableCell>
                {roleKeys.map((r) => {
                  const checked = roles[r]?.includes(perm) ?? false
                  return (
                    <TableCell key={r} className="text-center">
                      <div className="flex justify-center">
                        <Switch checked={checked} disabled />
                      </div>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
            {!loading && permissions.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={roleKeys.length + 1}
                  className="h-24 text-center text-muted-foreground"
                >
                  暂无权限数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const PAGE_SIZE = 8

function AuditTab() {
  const [logs, setLogs] = useState<ApiAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await adminApi.system.auditLogs({ pageSize: 100 })
        if (alive) setLogs(res.items)
      } catch {
        if (alive) toast.error("加载审计日志失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  // 真实 action 是英文点分字符串（如 refund.done），不再有 mock 的中文枚举可筛选，仅保留关键词搜索。
  const filtered = useMemo(() => {
    const kw = query.trim()
    if (!kw) return logs
    return logs.filter(
      (log) =>
        log.operator.includes(kw) ||
        (log.target ?? "").includes(kw) ||
        log.action.includes(kw)
    )
  }, [logs, query])

  const total = filtered.length
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <Card>
      <CardHeader>
        <CardTitle>操作审计日志</CardTitle>
        <CardDescription>
          记录改套餐、调积分、退款、封禁等敏感操作，只读不可篡改。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索操作人 / 操作 / 对象"
            className="pl-9 sm:max-w-xs"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
          />
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>操作人</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>变更前</TableHead>
              <TableHead>变更后</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {log.createdAt}
                </TableCell>
                <TableCell className="text-sm font-medium text-foreground">
                  {log.operator}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-normal">
                    {log.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {log.target ?? "-"}
                </TableCell>
                <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                  {log.before != null ? JSON.stringify(log.before) : "-"}
                </TableCell>
                <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                  {log.after != null ? JSON.stringify(log.after) : "-"}
                </TableCell>
              </TableRow>
            ))}
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            ) : paged.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  没有匹配的日志记录
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  )
}
