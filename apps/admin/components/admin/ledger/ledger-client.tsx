"use client"

import { useEffect, useMemo, useState } from "react"
import { ShieldCheck, CheckCircle2 } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TablePagination } from "@/components/admin/table-pagination"
import { LedgerTypeBadge } from "@/components/admin/status-badges"
import { formatBeijing } from "@/lib/utils"
import { type LedgerType } from "@/lib/mock-data"
import { adminApi, type ApiLedgerTx } from "@/lib/admin-api"

const PAGE_SIZE = 10

// 账本流水行：真实 /ledger 列表不带用户名/批次/幂等键，缺失字段用安全占位符。
interface LedgerRow {
  id: string
  userName: string
  type: string
  amount: number
  batch: string
  ref: string
  createdAt: string
}

function apiLedgerToRow(l: ApiLedgerTx, userName: string): LedgerRow {
  return {
    id: l.id,
    userName,
    type: l.type,
    amount: l.amount,
    batch: "-",
    ref: l.ref ?? "-",
    createdAt: formatBeijing(l.createdAt),
  }
}

export function LedgerClient() {
  const [userOptions, setUserOptions] = useState<{ id: string; name: string }[]>([])
  const [userId, setUserId] = useState("")
  const [type, setType] = useState("all")
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [check, setCheck] = useState<{ cached: number; actual: number; consistent: boolean } | null>(null)

  // 加载真实用户列表，作为用户选择器，默认选中第一个真实用户。
  useEffect(() => {
    async function loadUsers() {
      try {
        const res = await adminApi.users.list({ pageSize: 100 })
        const opts = res.items.map((u) => ({ id: u.id, name: u.nickname ?? u.phone ?? u.id }))
        setUserOptions(opts)
        if (opts.length > 0) setUserId(opts[0].id)
      } catch {
        toast.error("加载用户失败")
      }
    }
    void loadUsers()
  }, [])

  const currentUserName = userOptions.find((u) => u.id === userId)?.name ?? userId

  // 按用户 + 类型加载流水（真实接口按用户维度查询，不支持“全部用户”）。
  useEffect(() => {
    if (!userId) return
    let alive = true
    async function loadLedger() {
      setLoading(true)
      try {
        const res = await adminApi.ledger.list({ userId, type: type === "all" ? undefined : type, pageSize: 100 })
        if (!alive) return
        setRows(res.items.map((l) => apiLedgerToRow(l, currentUserName)))
      } catch {
        if (alive) toast.error("加载流水失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void loadLedger()
    return () => {
      alive = false
    }
  }, [userId, type, currentUserName])

  // 余额核对：缓存余额 vs 流水之和实算。
  useEffect(() => {
    if (!userId) {
      setCheck(null)
      return
    }
    let alive = true
    adminApi.ledger
      .check(userId)
      .then((res) => {
        if (alive) setCheck(res)
      })
      .catch(() => {
        if (alive) setCheck(null)
      })
    return () => {
      alive = false
    }
  }, [userId])

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [rows]
  )
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-6">
      {userId && check && (
        <Alert className="border-primary/30 bg-primary/5">
          <ShieldCheck />
          <AlertTitle className="flex items-center gap-2">
            账本可审计 · 余额核对
            {check.consistent ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="size-3.5" /> 一致
              </span>
            ) : (
              <span className="text-xs font-medium text-destructive">
                不一致
              </span>
            )}
          </AlertTitle>
          <AlertDescription>
            <span className="font-mono">
              {currentUserName} 缓存余额{" "}
              <span className="font-semibold text-foreground">
                {check.cached.toLocaleString()}
              </span>{" "}
              · 实际（流水之和）{" "}
              <span className="font-semibold text-foreground">
                {check.actual.toLocaleString()}
              </span>{" "}
              积分
            </span>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="gap-4">
          <CardTitle className="text-base">
            积分流水（只追加 · append-only）
          </CardTitle>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Select
              value={userId}
              onValueChange={(v) => {
                if (v) setUserId(v)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {userOptions.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}（{u.id}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v ?? "all")
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="流水类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="grant">赠送 grant</SelectItem>
                <SelectItem value="purchase">充值 purchase</SelectItem>
                <SelectItem value="hold">预扣 hold</SelectItem>
                <SelectItem value="settle">结算 settle</SelectItem>
                <SelectItem value="release">退还 release</SelectItem>
                <SelectItem value="expire">过期 expire</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="sm:ml-auto"
              onClick={() => {
                if (userOptions.length > 0) setUserId(userOptions[0].id)
                setType("all")
                setPage(1)
              }}
            >
              重置筛选
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>流水号</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="text-right">金额（±）</TableHead>
                  <TableHead>来源批次</TableHead>
                  <TableHead>关联 run / 订单</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">{l.id}</TableCell>
                    <TableCell className="text-sm">{l.userName}</TableCell>
                    <TableCell>
                      <LedgerTypeBadge type={l.type as LedgerType} />
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono font-medium tabular-nums ${
                        l.amount >= 0 ? "text-emerald-600" : "text-destructive"
                      }`}
                    >
                      {l.amount > 0 ? "+" : ""}
                      {l.amount.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.batch}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.ref}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.createdAt}
                    </TableCell>
                  </TableRow>
                ))}
                {paged.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {loading ? "加载中…" : "没有匹配的流水"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            page={page}
            pageSize={PAGE_SIZE}
            total={sorted.length}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  )
}
