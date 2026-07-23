"use client"
import { safeUUID } from "@/lib/uuid"

import { useEffect, useMemo, useState } from "react"
import { Search, RotateCcw } from "lucide-react"
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TablePagination } from "@/components/admin/table-pagination"
import {
  OrderStatusBadge,
  ReconcileBadge,
} from "@/components/admin/status-badges"
import {
  orderTypeLabel,
  type OrderRow,
  type OrderType,
  type OrderStatus,
} from "@/lib/mock-data"
import { adminApi, type ApiOrder } from "@/lib/admin-api"

const PAGE_SIZE = 8

// 真实 status ∈ created/paid/failed/unknown/refunded：created→pending(待支付)语义一致；
// unknown(结果待核对，需人工对账)单列，不再被折叠进 pending 而隐藏。
const ORDER_STATUSES: OrderStatus[] = ["paid", "pending", "refunded", "failed", "unknown"]

// 真实 payment_orders.type ∈ recharge/purchase/renewal（DB check 约束）。
function apiTypeToOrderType(t: string): OrderType {
  if (t === "recharge") return "recharge"
  if (t === "renewal") return "renew"
  return "single" // purchase 及其他 → 单次
}

// 列表接口未返回对账状态，默认 matched（真实对账另有差异工作台）。
function apiOrderToRow(o: ApiOrder): OrderRow {
  return {
    id: o.id,
    userId: o.userId,
    company: "-",
    type: apiTypeToOrderType(o.type),
    amount: o.amountCents / 100,
    status: ORDER_STATUSES.includes(o.status as OrderStatus) ? (o.status as OrderStatus) : "pending",
    alipayTradeNo: o.providerTradeNo ?? "-",
    reconcile: "matched",
    createdAt: o.createdAt.slice(0, 19).replace("T", " "),
  }
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

export function OrdersClient() {
  const [data, setData] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState("")
  const [type, setType] = useState("all")
  const [statusF, setStatusF] = useState("all")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<OrderRow | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await adminApi.orders.list({ pageSize: 100 })
      setData(res.items.map(apiOrderToRow))
    } catch {
      toast.error("加载订单失败")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    return data.filter((o) => {
      const kw = keyword.trim()
      const matchKw =
        !kw ||
        o.id.includes(kw) ||
        o.company.includes(kw) ||
        o.alipayTradeNo.includes(kw)
      const matchType = type === "all" || o.type === type
      const matchStatus = statusF === "all" || o.status === statusF
      return matchKw && matchType && matchStatus
    })
  }, [data, keyword, type, statusF])

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function reset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  async function refund(orderId: string, amountCents: number, reason: string, idempotencyKey: string) {
    try {
      await adminApi.orders.refund({
        orderId,
        amountCents,
        reason,
        idempotencyKey,
      })
      toast.success(`已发起退款：${orderId}`)
      setSelected(null)
      await load()
    } catch {
      toast.error("退款失败")
    }
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <CardTitle className="text-base">订单列表</CardTitle>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => reset(setKeyword)(e.target.value)}
              placeholder="搜索订单号 / 公司 / 支付宝交易号"
              className="pl-8"
            />
          </div>
          <Select
            value={type}
            items={{ all: "全部类型", recharge: "积分充值", single: "单笔购买", renew: "自动续费" }}
            onValueChange={(v) => reset(setType)(v ?? "all")}
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="订单类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="recharge">积分充值</SelectItem>
              <SelectItem value="single">单笔购买</SelectItem>
              <SelectItem value="renew">自动续费</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusF}
            items={{ all: "全部状态", paid: "已支付", pending: "待支付", refunded: "已退款", failed: "支付失败", unknown: "结果待核对" }}
            onValueChange={(v) => reset(setStatusF)(v ?? "all")}
          >
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder="支付状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="paid">已支付</SelectItem>
              <SelectItem value="pending">待支付</SelectItem>
              <SelectItem value="refunded">已退款</SelectItem>
              <SelectItem value="failed">支付失败</SelectItem>
              <SelectItem value="unknown">结果待核对</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>订单号</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>对账</TableHead>
                <TableHead>支付宝交易号</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((o) => (
                <TableRow
                  key={o.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(o)}
                >
                  <TableCell className="font-mono text-xs">{o.id}</TableCell>
                  <TableCell className="text-sm">
                    {orderTypeLabel[o.type]}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    ¥{o.amount.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell>
                    <ReconcileBadge status={o.reconcile} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {o.alipayTradeNo}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {o.createdAt}
                  </TableCell>
                </TableRow>
              ))}
              {paged.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {loading ? "加载中…" : "没有匹配的订单"}
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

      <OrderDetailDialog
        order={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onRefund={refund}
      />
    </Card>
  )
}

function OrderDetailDialog({
  order,
  onOpenChange,
  onRefund,
}: {
  order: OrderRow | null
  onOpenChange: (open: boolean) => void
  onRefund: (orderId: string, amountCents: number, reason: string, idempotencyKey: string) => void
}) {
  if (!order) return null
  return (
    <Dialog open={!!order} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{order.id}</DialogTitle>
          <DialogDescription>{order.company}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          <Info label="订单类型" value={orderTypeLabel[order.type]} />
          <Info label="金额" value={`¥${order.amount.toLocaleString()}`} />
          <Info label="支付状态" value={<OrderStatusBadge status={order.status} />} />
          <Info label="对账状态" value={<ReconcileBadge status={order.reconcile} />} />
          <Info
            label="支付宝交易号"
            value={
              <span className="font-mono text-xs">{order.alipayTradeNo}</span>
            }
          />
          <Info label="创建时间" value={order.createdAt} />
        </div>
        <Separator />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">关闭</Button>} />
          {order.status === "paid" ? (
            <RefundDialog
              order={order}
              onConfirm={(amountCents, reason, idemKey) =>
                onRefund(order.id, amountCents, reason, idemKey)
              }
            />
          ) : (
            <Button variant="outline" disabled>
              <RotateCcw data-icon="inline-start" />
              不可退款
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RefundDialog({
  order,
  onConfirm,
}: {
  order: OrderRow
  onConfirm: (amountCents: number, reason: string, idempotencyKey: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(String(order.amount))
  const [reason, setReason] = useState("")
  const [idemKey, setIdemKey] = useState(() => safeUUID()) // 稳定幂等键：同一退款对话框会话复用，防重复提交双退

  function submit() {
    const amt = Number(amount)
    if (!amt || amt <= 0 || amt > order.amount) {
      toast.error(`退款金额需在 0 ~ ${order.amount} 之间`)
      return
    }
    if (!reason.trim()) {
      toast.error("请填写退款原因")
      return
    }
    onConfirm(Math.round(amt * 100), reason, idemKey)
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setIdemKey(safeUUID()) // 每次打开=新退款意图，换新键
      }}
    >
      <DialogTrigger
        render={
          <Button variant="destructive">
            <RotateCcw data-icon="inline-start" />
            发起退款
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发起退款</DialogTitle>
          <DialogDescription>
            订单 {order.id}，原始金额 ¥{order.amount.toLocaleString()}。退款将原路返回至支付宝。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="refund-amount">退款金额（元）</FieldLabel>
            <Input
              id="refund-amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="refund-reason">退款原因（必填）</FieldLabel>
            <Textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：用户重复下单、服务未交付等"
              rows={3}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">取消</Button>} />
          <Button variant="destructive" onClick={submit}>
            确认退款
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
