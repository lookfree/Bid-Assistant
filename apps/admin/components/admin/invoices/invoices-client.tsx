"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TablePagination } from "@/components/admin/table-pagination"
import { formatBeijing } from "@/lib/utils"
import { adminApi, AdminApiError, type ApiInvoice } from "@/lib/admin-api"

const PAGE_SIZE = 10

// 发票状态徽标：待开票（中性）/已开票（成功）/已驳回（危险）。
const STATUS_META: Record<ApiInvoice["status"], { label: string; className: string }> = {
  pending: { label: "待开票", className: "border-border bg-muted text-muted-foreground" },
  issued: { label: "已开票", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  rejected: { label: "已驳回", className: "border-rose-200 bg-rose-50 text-rose-700" },
}
const STATUS_FILTER = { all: "全部状态", pending: "待开票", issued: "已开票", rejected: "已驳回" }
const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`
const titleTypeLabel = (t: ApiInvoice["titleType"]) => (t === "enterprise" ? "企业" : "个人")

function StatusBadge({ status }: { status: ApiInvoice["status"] }) {
  const m = STATUS_META[status]
  return (
    <Badge variant="outline" className={m.className}>
      {m.label}
    </Badge>
  )
}

// 按状态 + 分页加载（服务端分页）；reloadTick 变化强制重拉（开具/驳回成功后刷新）。
function useInvoiceList(status: string, page: number, reloadTick: number) {
  const [items, setItems] = useState<ApiInvoice[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      try {
        const res = await adminApi.invoices.list({ status: status === "all" ? undefined : status, page, pageSize: PAGE_SIZE })
        if (!alive) return
        setItems(res.items)
        setTotal(res.total)
      } catch {
        if (alive) toast.error("加载发票失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [status, page, reloadTick])

  return { items, total, loading }
}

export function InvoicesClient() {
  const [status, setStatus] = useState("all")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<ApiInvoice | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const { items, total, loading } = useInvoiceList(status, page, reloadTick)

  async function handle(id: string, body: Parameters<typeof adminApi.invoices.handle>[1]) {
    try {
      await adminApi.invoices.handle(id, body)
      toast.success(body.action === "issue" ? "已开具发票" : "已驳回开票申请")
      setSelected(null)
      setReloadTick((t) => t + 1)
    } catch (e) {
      const status = e instanceof AdminApiError ? e.status : 0
      toast.error(status === 403 ? "无权限：需要 invoice.write" : status === 409 ? "该申请已处理，请刷新" : "操作失败，请重试")
    }
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <CardTitle className="text-base">发票管理</CardTitle>
        <Select
          value={status}
          items={STATUS_FILTER}
          onValueChange={(v) => {
            setStatus(v ?? "all")
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="状态筛选" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_FILTER).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>申请时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>抬头</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>处理人</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="text-xs text-muted-foreground">{formatBeijing(inv.createdAt)}</TableCell>
                  <TableCell className="text-sm">{inv.userId.slice(0, 8)}</TableCell>
                  <TableCell className="max-w-[220px]">
                    <div className="truncate text-sm" title={inv.title}>
                      {inv.title}
                      <span className="ml-1 text-xs text-muted-foreground">（{titleTypeLabel(inv.titleType)}）</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-medium">{yuan(inv.amountCents)}</TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{inv.handledBy ?? "-"}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => setSelected(inv)}>
                      {inv.status === "pending" ? "处理" : "查看"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    {loading ? "加载中…" : "没有匹配的发票申请"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </CardContent>

      <InvoiceDialog invoice={selected} onOpenChange={(open) => !open && setSelected(null)} onSubmit={handle} />
    </Card>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium break-all">{value}</span>
    </div>
  )
}

function InvoiceDialog({
  invoice,
  onOpenChange,
  onSubmit,
}: {
  invoice: ApiInvoice | null
  onOpenChange: (open: boolean) => void
  onSubmit: (id: string, body: Parameters<typeof adminApi.invoices.handle>[1]) => void
}) {
  const [invoiceNo, setInvoiceNo] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState("")
  const [uploading, setUploading] = useState(false)

  // 每次切换到不同申请（或重新打开）时清空表单。
  useEffect(() => {
    setInvoiceNo("")
    setFile(null)
    setReason("")
    setUploading(false)
  }, [invoice])

  // 开具：先上传发票文件（若选了）拿 key，再提交 issue。上传失败给具体提示、不继续开具。
  async function submitIssue() {
    if (!invoice || !invoiceNo.trim() || uploading) return
    let fileKey: string | undefined
    if (file) {
      setUploading(true)
      try {
        fileKey = (await adminApi.invoices.uploadFile(invoice.id, file)).key
      } catch (e) {
        const code = e instanceof AdminApiError ? e.code : undefined
        toast.error(code === "unsupported_file" ? "文件格式不支持（仅 PDF/OFD/图片）" : code === "file_too_large" ? "文件过大（≤10MB）" : "上传失败，请重试")
        setUploading(false)
        return
      }
      setUploading(false)
    }
    onSubmit(invoice.id, { action: "issue", invoiceNo: invoiceNo.trim(), fileKey })
  }

  if (!invoice) return null
  const pending = invoice.status === "pending"

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发票申请</DialogTitle>
          <DialogDescription>
            {invoice.userId.slice(0, 8)} · {yuan(invoice.amountCents)} · {formatBeijing(invoice.createdAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          <Info label="当前状态" value={<StatusBadge status={invoice.status} />} />
          <Info label="抬头类型" value={titleTypeLabel(invoice.titleType)} />
          <Info label="发票抬头" value={invoice.title} />
          {invoice.titleType === "enterprise" && <Info label="税号" value={invoice.taxNo ?? "-"} />}
          <Info label="接收邮箱" value={invoice.email} />
          <Info label="关联订单" value={invoice.orderId.slice(0, 12)} />
          {invoice.remark && <Info label="备注" value={invoice.remark} />}
          {invoice.status === "issued" && <Info label="发票号" value={invoice.invoiceNo ?? "-"} />}
          {invoice.status === "rejected" && <Info label="驳回原因" value={invoice.rejectReason ?? "-"} />}
        </div>

        {pending && (
          <>
            <Separator />
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="inv-no">发票号（开具时填写）</FieldLabel>
                <Input id="inv-no" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={100} placeholder="线下开具后回填的发票号" />
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-file">电子发票文件（PDF/OFD/图片，选填，用户会员中心可下载）</FieldLabel>
                <Input
                  id="inv-file"
                  type="file"
                  accept=".pdf,.ofd,.jpg,.jpeg,.png"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file && <p className="text-xs text-muted-foreground">已选择：{file.name}</p>}
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-reason">驳回原因（驳回时填写）</FieldLabel>
                <Input id="inv-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="如抬头/税号有误" />
              </Field>
            </FieldGroup>
          </>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline">关闭</Button>} />
          {pending && (
            <>
              <Button
                variant="secondary"
                disabled={!reason.trim()}
                onClick={() => onSubmit(invoice.id, { action: "reject", reason: reason.trim() })}
              >
                驳回
              </Button>
              <Button disabled={!invoiceNo.trim() || uploading} onClick={() => void submitIssue()}>
                {uploading ? "上传中…" : "开具"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
