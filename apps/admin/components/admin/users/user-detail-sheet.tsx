"use client"

import { useState } from "react"
import { Ban, ShieldCheck, Coins } from "lucide-react"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  AccountStatusBadge,
  LedgerTypeBadge,
  TierBadge,
} from "@/components/admin/status-badges"
import {
  balanceFromLedger,
  ledger,
  type UserRow,
} from "@/lib/mock-data"

interface Props {
  user: UserRow | null
  onOpenChange: (open: boolean) => void
  onAdjustPoints: (userId: string, delta: number) => void
  onToggleBan: (userId: string) => void
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

export function UserDetailSheet({
  user,
  onOpenChange,
  onAdjustPoints,
  onToggleBan,
}: Props) {
  if (!user) return null
  const flows = ledger.filter((l) => l.userId === user.id)
  const balance = balanceFromLedger(user.id)

  return (
    <Sheet open={!!user} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {user.name}
            <TierBadge tier={user.tier} />
            <AccountStatusBadge status={user.status} />
          </SheetTitle>
          <SheetDescription>
            {user.id} · {user.phone} · {user.company}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-4">
          <section className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
            <InfoItem
              label="积分余额"
              value={
                <span className="text-base text-primary">
                  {user.points.toLocaleString()}
                </span>
              }
            />
            <InfoItem label="项目数" value={user.projects} />
            <InfoItem label="自动续费" value={user.autoRenew ? "已开启" : "未开启"} />
            <InfoItem label="注册时间" value={user.registeredAt} />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">订阅信息</h3>
            <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
              <InfoItem label="当前套餐" value={<TierBadge tier={user.subscription.plan} />} />
              <InfoItem label="计费周期" value={user.subscription.period} />
              <InfoItem label="开始日期" value={user.subscription.startAt} />
              <InfoItem label="下次续费" value={user.subscription.nextRenewAt} />
              <InfoItem
                label="订阅金额"
                value={`¥${user.subscription.amount.toLocaleString()}`}
              />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">积分流水</h3>
              <span className="text-xs text-muted-foreground">
                余额核对 ：流水之和 ={" "}
                <span className="font-mono font-medium text-foreground">
                  {balance.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead>关联</TableHead>
                    <TableHead>时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flows.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>
                        <LedgerTypeBadge type={f.type} />
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${
                          f.amount >= 0 ? "text-emerald-600" : "text-destructive"
                        }`}
                      >
                        {f.amount > 0 ? "+" : ""}
                        {f.amount.toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {f.ref}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.createdAt}
                      </TableCell>
                    </TableRow>
                  ))}
                  {flows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="h-16 text-center text-sm text-muted-foreground"
                      >
                        暂无积分流水
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>

        <Separator />
        <SheetFooter className="flex-row justify-end gap-2">
          <AdjustPointsDialog
            user={user}
            onConfirm={(delta) => onAdjustPoints(user.id, delta)}
          />
          {user.status === "active" ? (
            <BanDialog
              userName={user.name}
              onConfirm={() => {
                onToggleBan(user.id)
                toast.success(`已封禁用户 ${user.name}`)
              }}
            />
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                onToggleBan(user.id)
                toast.success(`已解封用户 ${user.name}`)
              }}
            >
              <ShieldCheck data-icon="inline-start" />
              解封账号
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function AdjustPointsDialog({
  user,
  onConfirm,
}: {
  user: UserRow
  onConfirm: (delta: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")

  function submit() {
    const delta = Number(amount)
    if (!delta || Number.isNaN(delta)) {
      toast.error("请输入有效的积分数（正数增加，负数扣减）")
      return
    }
    if (!reason.trim()) {
      toast.error("请填写调整原因")
      return
    }
    onConfirm(delta)
    toast.success(
      `已为 ${user.name} ${delta > 0 ? "增加" : "扣减"} ${Math.abs(delta)} 积分`
    )
    setOpen(false)
    setAmount("")
    setReason("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <Coins data-icon="inline-start" />
            调整积分
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手动调整积分</DialogTitle>
          <DialogDescription>
            对 {user.name}（当前 {user.points.toLocaleString()} 积分）进行调整，调整将写入积分账本。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="adjust-amount">
              调整数量（正数增加 / 负数扣减）
            </FieldLabel>
            <Input
              id="adjust-amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如 500 或 -200"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="adjust-reason">调整原因（必填）</FieldLabel>
            <Textarea
              id="adjust-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请说明调整原因，将记录到操作审计日志"
              rows={3}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">取消</Button>} />
          <Button onClick={submit}>确认调整</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BanDialog({
  userName,
  onConfirm,
}: {
  userName: string
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")

  function submit() {
    if (!reason.trim()) {
      toast.error("请填写封禁原因")
      return
    }
    onConfirm()
    setOpen(false)
    setReason("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="destructive">
            <Ban data-icon="inline-start" />
            封禁账号
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>封禁账号</DialogTitle>
          <DialogDescription>
            封禁后 {userName} 将无法登录与发起新任务，请填写封禁原因。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ban-reason">封禁原因（必填）</FieldLabel>
            <Textarea
              id="ban-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：异常批量调用、违规内容等"
              rows={3}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">取消</Button>} />
          <Button variant="destructive" onClick={submit}>
            确认封禁
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
