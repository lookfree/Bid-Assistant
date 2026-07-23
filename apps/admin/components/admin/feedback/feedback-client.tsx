"use client"

import { useEffect, useState } from "react"
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
} from "@/components/ui/dialog"
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
import { FeedbackStatusBadge } from "@/components/admin/status-badges"
import { feedbackTypeLabel } from "@/lib/mock-data"
import { formatBeijing } from "@/lib/utils"
import { adminApi, AdminApiError, type ApiFeedback } from "@/lib/admin-api"

const PAGE_SIZE = 10

// 用户展示：优先昵称，缺失则退化为 userId 前 8 位（真实反馈列表不带手机号）。
function userDisplay(f: ApiFeedback): string {
  return f.nickname || f.userId.slice(0, 8)
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

// 按状态 + 分页加载（服务端分页：page/pageSize 传给 API，用返回的 total 驱动分页器）。
// reloadTick 变化时强制重拉当前页（如处理成功后刷新，状态/页码本身未变不会触发 effect）。
function useFeedbackList(status: string, page: number, reloadTick: number) {
  const [items, setItems] = useState<ApiFeedback[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      try {
        const res = await adminApi.feedback.list({
          status: status === "all" ? undefined : status,
          page,
          pageSize: PAGE_SIZE,
        })
        if (!alive) return
        setItems(res.items)
        setTotal(res.total)
      } catch {
        if (alive) toast.error("加载反馈失败")
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

export function FeedbackClient() {
  const [status, setStatus] = useState("all")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<ApiFeedback | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const { items, total, loading } = useFeedbackList(status, page, reloadTick)

  async function handleFeedback(id: string, patch: { status: "processing" | "resolved"; reply?: string }) {
    try {
      await adminApi.feedback.handle(id, patch)
      toast.success("已更新反馈状态")
      setSelected(null)
      setReloadTick((t) => t + 1)
    } catch (e) {
      toast.error(e instanceof AdminApiError && e.status === 403 ? "无权限" : "处理失败")
    }
  }

  function onStatusChange(v: string) {
    setStatus(v)
    setPage(1)
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <CardTitle className="text-base">反馈工单</CardTitle>
        <FeedbackFilterBar status={status} onStatusChange={onStatusChange} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FeedbackTable items={items} loading={loading} onSelect={setSelected} />
        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      </CardContent>

      <FeedbackDialog
        feedback={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onSubmit={handleFeedback}
      />
    </Card>
  )
}

function FeedbackFilterBar({
  status,
  onStatusChange,
}: {
  status: string
  onStatusChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select
        value={status}
        items={{ all: "全部", pending: "待处理", processing: "处理中", resolved: "已解决" }}
        onValueChange={(v) => onStatusChange(v ?? "all")}
      >
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="状态筛选" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部</SelectItem>
          <SelectItem value="pending">待处理</SelectItem>
          <SelectItem value="processing">处理中</SelectItem>
          <SelectItem value="resolved">已解决</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function FeedbackTable({
  items,
  loading,
  onSelect,
}: {
  items: ApiFeedback[]
  loading: boolean
  onSelect: (f: ApiFeedback) => void
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>提交时间</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>内容</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>处理人</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((f) => (
            <FeedbackRow key={f.id} feedback={f} onSelect={onSelect} />
          ))}
          {items.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="h-24 text-center text-muted-foreground"
              >
                {loading ? "加载中…" : "没有匹配的反馈"}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function FeedbackRow({
  feedback: f,
  onSelect,
}: {
  feedback: ApiFeedback
  onSelect: (f: ApiFeedback) => void
}) {
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground">
        {formatBeijing(f.createdAt)}
      </TableCell>
      <TableCell className="text-sm">{userDisplay(f)}</TableCell>
      <TableCell className="text-sm">{feedbackTypeLabel[f.type]}</TableCell>
      <TableCell className="max-w-[240px]">
        <div className="truncate" title={f.content}>
          {f.content}
        </div>
      </TableCell>
      <TableCell>
        <FeedbackStatusBadge status={f.status} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {f.handledBy ?? "-"}
      </TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={() => onSelect(f)}>
          处理
        </Button>
      </TableCell>
    </TableRow>
  )
}

function FeedbackDialog({
  feedback,
  onOpenChange,
  onSubmit,
}: {
  feedback: ApiFeedback | null
  onOpenChange: (open: boolean) => void
  onSubmit: (id: string, patch: { status: "processing" | "resolved"; reply?: string }) => void
}) {
  const [reply, setReply] = useState("")

  // 每次切换到不同工单（或重新打开）时，回显该工单已有的回复。
  useEffect(() => {
    setReply(feedback?.reply ?? "")
  }, [feedback])

  if (!feedback) return null

  function submit(status: "processing" | "resolved") {
    onSubmit(feedback!.id, { status, reply: reply.trim() || undefined })
  }

  return (
    <Dialog open={!!feedback} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>反馈详情</DialogTitle>
          <DialogDescription>
            {userDisplay(feedback)} · {feedbackTypeLabel[feedback.type]} ·{" "}
            {formatBeijing(feedback.createdAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          <Info label="当前状态" value={<FeedbackStatusBadge status={feedback.status} />} />
          <Info label="联系方式" value={feedback.contact ?? "-"} />
          <Info label="关联项目" value={feedback.projectId ?? "-"} />
          <Info label="处理人" value={feedback.handledBy ?? "-"} />
        </div>
        <Separator />
        <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
          {feedback.content}
        </div>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="feedback-reply">回复用户（选填）</FieldLabel>
            <Textarea
              id="feedback-reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="给用户的处理说明"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">取消</Button>} />
          <Button variant="secondary" onClick={() => submit("processing")}>
            标记处理中
          </Button>
          <Button onClick={() => submit("resolved")}>标记已解决</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
