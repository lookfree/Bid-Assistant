"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Search, ShieldCheck } from "lucide-react"
import { permLabel, actionLabel, diffRows } from "@/lib/admin-labels"
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
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TablePagination } from "@/components/admin/table-pagination"
import { adminApi, AdminApiError, type ApiAdmin, type ApiAuditLog } from "@/lib/admin-api"

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

const ROLE_ITEMS = { superadmin: "超级管理员", finance: "财务", ops: "运营", support: "客服" }

function AccountsTab() {
  const [accounts, setAccounts] = useState<ApiAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<ApiAdmin | null>(null)

  async function load() {
    try {
      const res = await adminApi.system.admins({ pageSize: 100 })
      setAccounts(res.items)
    } catch {
      toast.error("加载运营账号失败")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  // 改角色 / 启用停用：调 PUT /admins/:id（后端 admin.manage 把关 + 审计）,成功即更新本行。
  async function patch(id: string, p: { role?: string; status?: string }) {
    try {
      const updated = await adminApi.system.updateAdmin(id, p)
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)))
      toast.success("已保存")
    } catch (e) {
      toast.error(e instanceof AdminApiError && e.status === 403 ? "无权限：需要 admin.manage" : "保存失败，请重试")
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>运营账号</CardTitle>
          <CardDescription>共 {accounts.length} 个内部账号。可新增账号、调整角色、启用/停用。</CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          新增账号
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
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
                    <span className="text-sm font-medium text-foreground">{op.username}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Select value={op.role} items={ROLE_ITEMS} onValueChange={(v) => v && v !== op.role && patch(op.id, { role: v })}>
                    <SelectTrigger className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ROLE_ITEMS).map(([v, label]) => (
                        <SelectItem key={v} value={v}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{op.createdAt?.slice(0, 10) ?? "-"}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={op.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-muted text-muted-foreground"}
                  >
                    {op.status === "active" ? "启用" : "已停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setResetTarget(op)}>
                      重置密码
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => patch(op.id, { status: op.status === "active" ? "disabled" : "active" })}
                    >
                      {op.status === "active" ? "停用" : "启用"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            ) : accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  暂无运营账号
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
      {createOpen && <CreateAdminDialog onClose={() => setCreateOpen(false)} onCreated={() => void load()} />}
      {resetTarget && <ResetPasswordDialog admin={resetTarget} onClose={() => setResetTarget(null)} />}
    </Card>
  )
}

// 密码策略（与后端 system.ts PASSWORD 同规则）：≥8 位，字母+数字+特殊字符缺一不可；返回错误文案或 null。
function passwordError(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位"
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return "需同时包含字母、数字和特殊字符"
  return null
}

/* 重置密码弹窗：超管为任意账号（含自己）设新密码（≥8 位含字母数字 + 两次确认）。走 PUT /admins/:id，
   服务端只哈希入库、审计记 passwordReset 标记不落明文。重置后该账号需用新密码重新登录。 */
function ResetPasswordDialog({ admin, onClose }: { admin: ApiAdmin; onClose: () => void }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [saving, setSaving] = useState(false)
  const pwErr = password ? passwordError(password) : null
  const matchErr = confirm && confirm !== password ? "两次输入不一致" : null
  const valid = passwordError(password) === null && confirm === password

  async function submit() {
    if (!valid || saving) return
    setSaving(true)
    try {
      await adminApi.system.updateAdmin(admin.id, { password })
      toast.success(`已重置 ${admin.username} 的密码`)
      onClose()
    } catch (e) {
      toast.error(e instanceof AdminApiError && e.status === 403 ? "无权限：需要 admin.manage" : "重置失败，请重试")
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置密码 · {admin.username}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <p className="text-sm text-muted-foreground">
            为该账号设置新登录密码。重置后旧密码立即失效，该账号需用新密码重新登录。
          </p>
          <label className="flex flex-col gap-1 text-sm">
            新密码
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，含字母、数字和特殊字符" />
            {pwErr && <span className="text-xs text-destructive">{pwErr}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            确认新密码
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入新密码" />
            {matchErr && <span className="text-xs text-destructive">{matchErr}</span>}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? "重置中…" : "确认重置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* 新增运营账号弹窗：用户名 + 角色 + 密码（≥8 位,与后端 CreateBody 一致）。 */
function CreateAdminDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("")
  const [role, setRole] = useState("ops")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [saving, setSaving] = useState(false)

  const pwErr = password ? passwordError(password) : null
  const matchErr = confirm && confirm !== password ? "两次输入不一致" : null
  const valid = username.trim().length > 0 && passwordError(password) === null && confirm === password
  async function submit() {
    if (!valid || saving) return
    setSaving(true)
    try {
      await adminApi.system.createAdmin({ username: username.trim(), role, password })
      toast.success("账号已创建")
      onCreated()
      onClose()
    } catch (e) {
      toast.error(
        e instanceof AdminApiError && e.status === 403
          ? "无权限：需要 admin.manage"
          : e instanceof AdminApiError && e.status === 409
            ? "用户名已存在"
            : "创建失败，请重试",
      )
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增运营账号</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <label className="flex flex-col gap-1 text-sm">
            用户名
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="登录用户名" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            角色
            <Select value={role} items={ROLE_ITEMS} onValueChange={(v) => v && setRole(v)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ROLE_ITEMS).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            初始密码
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，含字母、数字和特殊字符" />
            {pwErr && <span className="text-xs text-destructive">{pwErr}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            确认密码
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" />
            {matchErr && <span className="text-xs text-destructive">{matchErr}</span>}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? "创建中…" : "创建账号"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                  {permLabel(perm)}
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
  const [diffLog, setDiffLog] = useState<ApiAuditLog | null>(null)

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
              <TableHead className="text-right">变更</TableHead>
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
                    {actionLabel(log.action)}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {log.target ?? "-"}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" className="h-7 text-primary" onClick={() => setDiffLog(log)}>
                    查看对照
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            ) : paged.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
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
      {diffLog && <AuditDiffDialog log={diffLog} onClose={() => setDiffLog(null)} />}
    </Card>
  )
}

/* 变更对照弹窗（此前变更前/后两列直出裸 JSON,运营看不懂,不专业）：点「查看对照」在一处弹窗里
   按「字段 | 变更前 | 变更后」逐字段对照,有变化的行高亮（前删除色、后强调色）,未变化的淡显。 */
function AuditDiffDialog({ log, onClose }: { log: ApiAuditLog; onClose: () => void }) {
  const rows = diffRows(log.before, log.after)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>变更对照 · {actionLabel(log.action)}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>操作人：{log.operator}</span>
          <span>时间：{log.createdAt}</span>
          <span>对象：{log.target ?? "-"}</span>
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">本次操作无字段级变更记录。</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/3">字段</TableHead>
                  <TableHead>变更前</TableHead>
                  <TableHead>变更后</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key} className={r.changed ? undefined : "opacity-60"}>
                    <TableCell className="text-sm font-medium text-foreground">{r.label}</TableCell>
                    <TableCell className={`break-all text-sm ${r.changed ? "text-rose-600 line-through decoration-rose-300" : "text-muted-foreground"}`}>
                      {r.before}
                    </TableCell>
                    <TableCell className={`break-all text-sm ${r.changed ? "font-medium text-emerald-600" : "text-muted-foreground"}`}>
                      {r.after}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
