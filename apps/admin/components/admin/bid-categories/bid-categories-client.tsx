"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { TablePagination } from "@/components/admin/table-pagination"
import { formatBeijing } from "@/lib/utils"
import { adminApi, AdminApiError, type ApiCategoryCorrection, type ApiCategorySummaryRow } from "@/lib/admin-api"

const PAGE_SIZE = 10

const LABEL: Record<string, string> = { goods: "货物标", services: "服务标", engineering: "工程标" }
const label = (v: string) => LABEL[v] ?? v
/** 有序数组，首元素为主类别；第二个是「本标还涉及」的次类别。 */
const labels = (vs: string[]) => (vs.length ? vs.map(label).join(" + ") : "—")

export function BidCategoriesClient() {
  const [rows, setRows] = useState<ApiCategoryCorrection[]>([])
  const [summary, setSummary] = useState<ApiCategorySummaryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      adminApi.bidCategories.corrections({ page, pageSize: PAGE_SIZE }),
      adminApi.bidCategories.summary(),
    ])
      .then(([list, sum]) => {
        if (!alive) return
        setRows(list.items)
        setTotal(list.total)
        setSummary(sum.items)
      })
      .catch((e) => toast.error(e instanceof AdminApiError ? e.message : "加载失败"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [page])

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>判错方向</CardTitle>
          <CardDescription>
            按主类别聚合「系统判成 A、用户改成 B」的次数。某个方向持续偏高，就该去改分类提示词——
            这是判定质量唯一的反馈来源。没判出类型时用户的选择不计入——那是覆盖率问题，不是准确率问题。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summary.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无纠偏记录——判定与用户选择一致，或还没有人改判。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {summary.map((s) => (
                <Badge key={`${s.detected}-${s.confirmed}`} variant="outline" className="text-sm">
                  {label(s.detected)} → {label(s.confirmed)}
                  <span className="ml-1.5 font-semibold">{s.count}</span>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>纠偏明细</CardTitle>
          <CardDescription>用户在读标页/审查页改判的记录，最近的在前。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead>系统判定</TableHead>
                <TableHead>用户改判为</TableHead>
                <TableHead>置信度</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">加载中…</TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">暂无记录</TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[280px] truncate">{r.projectName ?? r.projectId.slice(0, 8)}</TableCell>
                    <TableCell>{labels(r.detected)}</TableCell>
                    <TableCell className="font-medium">{labels(r.confirmed)}</TableCell>
                    <TableCell className="text-muted-foreground">{r.confidence ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatBeijing(r.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <TablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </CardContent>
      </Card>
    </div>
  )
}
