"use client"

import { Fragment, useMemo, useState } from "react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  opsAccounts,
  roleLabel,
  permissionGroups,
  rolePermissions,
  auditLogs,
  type RoleKey,
} from "@/lib/mock-data"
import { TablePagination } from "@/components/admin/table-pagination"

const roleKeys = Object.keys(roleLabel) as RoleKey[]

export function SystemClient() {
  const [perms, setPerms] = useState<Record<RoleKey, Set<string>>>(() => {
    const init = {} as Record<RoleKey, Set<string>>
    roleKeys.forEach((r) => (init[r] = new Set(rolePermissions[r])))
    return init
  })

  function togglePerm(role: RoleKey, permKey: string, value: boolean) {
    setPerms((prev) => {
      const next = { ...prev, [role]: new Set(prev[role]) }
      if (value) next[role].add(permKey)
      else next[role].delete(permKey)
      return next
    })
    toast.success("权限已更新")
  }

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
          <RolesTab perms={perms} onToggle={togglePerm} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AccountsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>运营账号</CardTitle>
        <CardDescription>共 {opsAccounts.length} 个内部账号。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>最近登录</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {opsAccounts.map((op) => (
              <TableRow key={op.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-accent text-accent-foreground text-xs">
                        {op.name.slice(0, 1)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">
                        {op.name}
                      </span>
                      <span className="text-xs text-muted-foreground">{op.email}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-normal">
                    {roleLabel[op.role]}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {op.lastLogin}
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
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RolesTab({
  perms,
  onToggle,
}: {
  perms: Record<RoleKey, Set<string>>
  onToggle: (role: RoleKey, permKey: string, value: boolean) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>角色权限矩阵 (RBAC)</CardTitle>
        <CardDescription>
          勾选每个角色可执行的操作。超级管理员默认拥有全部权限。
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
                      {roleLabel[r]}
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
            {permissionGroups.map((group) => (
              <Fragment key={group.group}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell
                    colSpan={roleKeys.length + 1}
                    className="py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group.group}
                  </TableCell>
                </TableRow>
                {group.perms.map((perm) => (
                  <TableRow key={perm.key}>
                    <TableCell className="text-sm font-medium text-foreground">
                      {perm.name}
                    </TableCell>
                    {roleKeys.map((r) => {
                      const locked = r === "superadmin"
                      const checked = locked || perms[r].has(perm.key)
                      return (
                        <TableCell key={r} className="text-center">
                          <div className="flex justify-center">
                            <Switch
                              checked={checked}
                              disabled={locked}
                              onCheckedChange={(v) => onToggle(r, perm.key, v)}
                            />
                          </div>
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const PAGE_SIZE = 8

function AuditTab() {
  const [query, setQuery] = useState("")
  const [action, setAction] = useState("all")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    return auditLogs.filter((log) => {
      const matchQuery =
        !query ||
        log.operator.includes(query) ||
        log.target.includes(query) ||
        log.detail.includes(query)
      const matchAction = action === "all" || log.action === action
      return matchQuery && matchAction
    })
  }, [query, action])

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索操作人 / 对象 / 详情"
              className="pl-9"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <Select
            value={action}
            onValueChange={(v) => {
              setAction(v ?? "all")
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="操作类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作</SelectItem>
              <SelectItem value="改套餐">改套餐</SelectItem>
              <SelectItem value="调积分">调积分</SelectItem>
              <SelectItem value="退款">退款</SelectItem>
              <SelectItem value="封禁">封禁</SelectItem>
              <SelectItem value="改积分口径">改积分口径</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>操作人</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>详情</TableHead>
              <TableHead>结果</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {log.at}
                </TableCell>
                <TableCell className="text-sm font-medium text-foreground">
                  <div className="flex flex-col">
                    <span>{log.operator}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {roleLabel[log.role]}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-normal">
                    {log.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {log.target}
                </TableCell>
                <TableCell className="max-w-72 truncate text-sm text-muted-foreground">
                  {log.detail}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      log.result === "成功"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-destructive/30 bg-destructive/10 text-destructive"
                    }
                  >
                    {log.result}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {paged.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  没有匹配的日志记录
                </TableCell>
              </TableRow>
            )}
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
