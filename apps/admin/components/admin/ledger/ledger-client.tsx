"use client"

import { useMemo, useState } from "react"
import { ShieldCheck, CheckCircle2 } from "lucide-react"

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
import {
  balanceFromLedger,
  ledger,
  users,
  type LedgerType,
} from "@/lib/mock-data"

const PAGE_SIZE = 10
const userOptions = users.map((u) => ({ id: u.id, name: u.name }))

export function LedgerClient() {
  const [userId, setUserId] = useState("U100237")
  const [type, setType] = useState("all")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    return ledger
      .filter((l) => (userId === "all" ? true : l.userId === userId))
      .filter((l) => (type === "all" ? true : l.type === type))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [userId, type])

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const currentUser = users.find((u) => u.id === userId)
  const computed = userId === "all" ? null : balanceFromLedger(userId)
  const matched = currentUser ? computed === currentUser.points : true

  return (
    <div className="flex flex-col gap-6">
      {userId !== "all" && currentUser && (
        <Alert className="border-primary/30 bg-primary/5">
          <ShieldCheck />
          <AlertTitle className="flex items-center gap-2">
            账本可审计 · 余额核对
            {matched ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="size-3.5" /> 已对平
              </span>
            ) : (
              <span className="text-xs font-medium text-destructive">
                存在差异
              </span>
            )}
          </AlertTitle>
          <AlertDescription>
            <span className="font-mono">
              {currentUser.name} 余额 = 流水之和 ={" "}
              <span className="font-semibold text-foreground">
                {computed?.toLocaleString()}
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
                setUserId(v ?? "all")
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部用户</SelectItem>
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
                setUserId("all")
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
                  <TableHead>幂等键</TableHead>
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
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.idempotencyKey}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.createdAt}
                    </TableCell>
                  </TableRow>
                ))}
                {paged.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-24 text-center text-muted-foreground"
                    >
                      没有匹配的流水
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
      </Card>
    </div>
  )
}
