"use client"

import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"

import {
  Card,
  CardContent,
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
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TablePagination } from "@/components/admin/table-pagination"
import {
  AccountStatusBadge,
  TierBadge,
} from "@/components/admin/status-badges"
import { UserDetailSheet } from "@/components/admin/users/user-detail-sheet"
import type { UserRow, MemberTier, AccountStatus } from "@/lib/mock-data"
import { adminApi, type ApiUser } from "@/lib/admin-api"

const PAGE_SIZE = 8

// plans.code(free/personal/professional) → 前端档位（pro）。
const TIER_MAP: Record<string, MemberTier> = { free: "free", personal: "personal", professional: "pro" }

// 真实用户 → 列表行。列表接口没有的字段（公司/自动续费/项目数/订阅明细）合理默认，详情页再拉全。
function apiUserToRow(u: ApiUser): UserRow {
  const tier: MemberTier = (u.tier ? TIER_MAP[u.tier] : undefined) ?? "free"
  return {
    id: u.id,
    phone: u.phone ?? "-",
    name: u.nickname ?? "未命名用户",
    company: "-",
    registeredAt: u.createdAt?.slice(0, 10) ?? "-",
    tier,
    points: u.balance ?? 0,
    autoRenew: false,
    status: (u.status as AccountStatus) ?? "active",
    projects: 0,
    subscription: { plan: tier, period: "月付", startAt: "-", nextRenewAt: "-", amount: 0 },
  }
}

export function UsersClient() {
  const [data, setData] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState("")
  const [tier, setTier] = useState<string>("all")
  const [status, setStatus] = useState<string>("all")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<UserRow | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await adminApi.users.list({ pageSize: 100 })
      setData(res.items.map(apiUserToRow))
    } catch {
      toast.error("加载用户失败")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    return data.filter((u) => {
      const kw = keyword.trim()
      const matchKw =
        !kw ||
        u.phone.includes(kw) ||
        u.name.includes(kw) ||
        u.company.includes(kw) ||
        u.id.includes(kw)
      const matchTier = tier === "all" || u.tier === tier
      const matchStatus = status === "all" || u.status === status
      return matchKw && matchTier && matchStatus
    })
  }, [data, keyword, tier, status])

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  async function adjustPoints(userId: string, delta: number) {
    try {
      await adminApi.users.grantCredits(userId, { amount: delta, reason: "运营手动调整", idempotencyKey: crypto.randomUUID() })
      toast.success(`已调整 ${delta > 0 ? "+" : ""}${delta} 积分`)
      setSelected((prev) => (prev && prev.id === userId ? { ...prev, points: prev.points + delta } : prev))
      await load()
    } catch {
      toast.error("调整积分失败（可能余额不足）")
    }
  }

  async function toggleBan(userId: string) {
    const u = data.find((x) => x.id === userId)
    if (!u) return
    try {
      if (u.status === "active") await adminApi.users.ban(userId)
      else await adminApi.users.unban(userId)
      toast.success(u.status === "active" ? "已封禁" : "已解封")
      setSelected((prev) => (prev && prev.id === userId ? { ...prev, status: prev.status === "active" ? "banned" : "active" } : prev))
      await load()
    } catch {
      toast.error("操作失败")
    }
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <CardTitle className="text-base">用户列表</CardTitle>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => resetPage(setKeyword)(e.target.value)}
              placeholder="搜索手机号 / 姓名 / 公司 / ID"
              className="pl-8"
            />
          </div>
          <Select value={tier} onValueChange={(v) => resetPage(setTier)(v ?? "all")}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="会员档位" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部档位</SelectItem>
              <SelectItem value="free">免费版</SelectItem>
              <SelectItem value="personal">个人版</SelectItem>
              <SelectItem value="pro">专业版</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => resetPage(setStatus)(v ?? "all")}>
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder="账号状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">正常</SelectItem>
              <SelectItem value="banned">已封禁</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>注册时间</TableHead>
                <TableHead>会员档位</TableHead>
                <TableHead className="text-right">积分余额</TableHead>
                <TableHead>自动续费</TableHead>
                <TableHead>账号状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(u)}
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{u.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {u.phone} · {u.company}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {u.registeredAt}
                  </TableCell>
                  <TableCell>
                    <TierBadge tier={u.tier} />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {u.points.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">
                    {u.autoRenew ? (
                      <span className="text-emerald-600">已开启</span>
                    ) : (
                      <span className="text-muted-foreground">未开启</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge status={u.status} />
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(u)}
                    >
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {paged.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {loading ? "加载中…" : "没有匹配的用户"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
        />
      </CardContent>

      <UserDetailSheet
        user={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onAdjustPoints={adjustPoints}
        onToggleBan={toggleBan}
      />
    </Card>
  )
}
