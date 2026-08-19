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
import { useCan } from "@/lib/admin-perms"
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
import { orderPlanLabel } from "@/lib/admin-labels"

const PAGE_SIZE = 8

// 真实 status ∈ created/paid/failed/unknown/refunded：created→pending(待支付)语义一致；
// unknown(结果待核对，需人工对账)单列，不再被折叠进 pending 而隐藏。
const ORDER_STATUSES: OrderStatus[] = ["paid", "pending", "refunded", "failed", "unknown"]

// 前端类型取值已与 DB 一致（见 mock-data.ts 的 OrderType），不再需要翻译层；
// 只把库外的意外取值兜到 purchase，避免整行渲染成空白。
const ORDER_TYPES: OrderType[] = ["recharge", "purchase", "renewal"]
const asOrderType = (t: string): OrderType => (ORDER_TYPES.includes(t as OrderType) ? (t as OrderType) : "purchase")

// 列表接口未返回对账状态，默认 matched（真实对账另有差异工作台）。
function apiOrderToRow(o: ApiOrder): OrderRow {
  return {
    id: o.id,
    userId: o.userId,
    userName: o.userName || "-",
    company: "-",
    type: asOrderType(o.type),
    planLabel: orderPlanLabel(o),
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
        (o.userName ?? "").includes(kw) ||
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

  /* 扣回护栏被触发时暂存本次请求，供操作员确认后原参重发（幂等键沿用，不会双退）。
     后端设计就是「拒绝 → 操作员确认后携 allowNegativeBalance 重试」，但后台一直没有这个出口，
     于是充值送的积分一旦被用户花掉，这笔订单就永远退不了（同一订单连续 4 次 422，生产实测）。 */
  const [clawbackConfirm, setClawbackConfirm] = useState<
    { orderId: string; amountCents: number; reason: string; idempotencyKey: string; why: string } | null
  >(null)

  async function refund(orderId: string, amountCents: number, reason: string, idempotencyKey: string,
                        allowNegativeBalance = false) {
    try {
      // 通道拒绝时接口是 200 + {status:"failed"}（HTTP 层没出错）：必须按 status 分支。
      // 原来无条件弹「已发起退款」——退款其实失败、订单仍是已支付，运营以为退成功了（生产实测）。
      const res = await adminApi.orders.refund({ orderId, amountCents, reason, idempotencyKey, allowNegativeBalance })
      if (res.status === "done") {
        toast.success("退款成功", { description: "订单状态已更新为已退款，积分按比例扣回。" })
      } else if (res.status === "pending") {
        toast.warning("通道结果不明，已转人工核对", {
          description: `请勿重复发起（可能已退款）。${res.reason ?? ""}`,
        })
      } else {
        // 「通道拒绝，未返回原因」是错的：实测通道其实回了原因（如「今日新收款余额小于退款额[EP36]」），
        // 是我们没把它带到界面。把没验证过的说法当事实报给运营，会让人往错的方向查。
        toast.error("退款未成功，订单状态未变", {
          description: res.reason ?? "没取到通道返回的原因（服务端已记录日志，请把订单号发给技术）",
        })
      }
      setSelected(null)
      setClawbackConfirm(null)
      await load()
    } catch (e) {
      const why = e instanceof Error ? e.message : "请重试"
      // 扣回护栏：不是终点，而是要操作员确认。给出原因 + 确认入口，别让运营对着 422 干瞪眼。
      if (!allowNegativeBalance && why.includes("allowNegativeBalance")) {
        setClawbackConfirm({ orderId, amountCents, reason, idempotencyKey, why })
        return
      }
      toast.error("退款请求未成功", { description: why })
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
              placeholder="搜索订单号 / 用户 / 支付宝交易号"
              className="pl-8"
            />
          </div>
          <Select
            value={type}
            items={{ all: "全部类型", ...orderTypeLabel }}
            onValueChange={(v) => reset(setType)(v ?? "all")}
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="订单类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="recharge">{orderTypeLabel.recharge}</SelectItem>
              <SelectItem value="purchase">{orderTypeLabel.purchase}</SelectItem>
              <SelectItem value="renewal">{orderTypeLabel.renewal}</SelectItem>
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
                <TableHead>用户</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>套餐 / 周期</TableHead>
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
                  <TableCell className="text-sm">{o.userName || "—"}</TableCell>
                  <TableCell className="text-sm">
                    {orderTypeLabel[o.type]}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {o.planLabel || "—"}
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
                    colSpan={9}
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

      {/* 扣回护栏的二次确认：把服务端的原因原样摆出来，操作员确认后原参重发（幂等键不变，不会双退）。 */}
      <Dialog open={!!clawbackConfirm} onOpenChange={(open) => !open && setClawbackConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>需要确认：积分扣不回来</DialogTitle>
            <DialogDescription>
              退款要按比例扣回当初随充值送出的积分，但该用户已经把积分消费掉了。
              继续退款会让该用户的积分余额变成负数（后续消费需先充回）。
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
            {clawbackConfirm?.why}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClawbackConfirm(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const c = clawbackConfirm
                if (c) void refund(c.orderId, c.amountCents, c.reason, c.idempotencyKey, true)
              }}
            >
              确认退款（允许负余额）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          <DialogDescription>{order.userName || order.company}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          <Info label="订单类型" value={orderTypeLabel[order.type]} />
          {order.planLabel && <Info label="套餐 / 周期" value={order.planLabel} />}
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
  const can = useCan()
  // 按钮权限（2026-08-02 可编辑 RBAC）：没有 refund.write 的角色（如 support 只读订单）不渲染退款入口
  if (!can("refund.write")) return null
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
