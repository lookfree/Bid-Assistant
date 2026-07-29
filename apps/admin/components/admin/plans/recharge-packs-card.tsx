"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save, RotateCcw, Plus, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import {
  toRechargeRows,
  toRechargeConfig,
  unitPricePer100,
  validateRechargeRows,
  type RechargePackRow,
} from "@/lib/recharge-packs-config"

/** 充值档位配置卡：C 端「单独充值积分」区完全由这份配置渲染（含每 100 积分单价文案）。 */
function useRechargeState() {
  const [rows, setRows] = useState<RechargePackRow[] | null>(null)
  const [saved, setSaved] = useState<string>("") // 存序列化快照，行数组增删改都能准确判 dirty
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  async function loadData(isAlive: () => boolean) {
    setLoading(true)
    try {
      const r = toRechargeRows(await adminApi.plans.getConfigs())
      if (!isAlive()) return
      setRows(r)
      setSaved(JSON.stringify(r))
    } catch {
      if (isAlive()) toast.error("加载充值档位失败")
    } finally {
      if (isAlive()) setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    loadData(() => alive)
    return () => {
      alive = false
    }
  }, [])

  const dirty = rows !== null && JSON.stringify(rows) !== saved

  async function save() {
    if (!rows) return
    setSaving(true)
    try {
      await adminApi.plans.setConfig("recharge_packs", toRechargeConfig(rows))
      setSaved(JSON.stringify(rows))
      toast.success("充值档位已保存并生效", { description: "C 端充值区与单价文案立即按新配置展示。" })
    } catch (e) {
      const perm = e instanceof AdminApiError && e.status === 403
      toast.error(perm ? "无权限：需要 config.write 权限" : "保存失败，请重试", { description: "当前编辑内容已保留。" })
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    await loadData(() => true)
    toast.info("已还原为服务器上次保存的配置")
  }

  return { rows, setRows, loading, saving, dirty, save, reset }
}

export function RechargePacksCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { rows, setRows, loading, saving, dirty, save, reset } = useRechargeState()

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const { errors, formError } = rows ? validateRechargeRows(rows) : { errors: {}, formError: undefined }
  const hasErrors = Object.keys(errors).length > 0 || !!formError

  const patch = (i: number, p: Partial<RechargePackRow>) =>
    setRows((prev) => (prev ? prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)) : prev))

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>充值档位</CardTitle>
          <CardDescription>
            C 端「单独充值积分」区直接由此渲染；每 100 积分单价由金额与积分实时算出，无需另配文案。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Badge variant="secondary" className="font-normal">
              有未保存的更改
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={reset} disabled={saving || loading}>
            <RotateCcw data-icon="inline-start" />
            还原
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || loading || hasErrors}>
            <Save data-icon="inline-start" />
            保存并生效
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !rows ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="hidden gap-3 px-1 text-xs text-muted-foreground sm:grid sm:grid-cols-[1.2fr_1fr_1fr_auto_2.2rem]">
              <span>档位 id（下单凭据，勿随意改）</span>
              <span>金额（元）</span>
              <span>到账积分（含赠送）</span>
              <span className="whitespace-nowrap">单价</span>
              <span />
            </div>
            {rows.map((r, i) => {
              const unit = unitPricePer100(r)
              return (
                <div key={i} className="grid gap-3 sm:grid-cols-[1.2fr_1fr_1fr_auto_2.2rem] sm:items-start">
                  <div className="flex flex-col gap-1">
                    <Input className="h-9" value={r.id} onChange={(e) => patch(i, { id: e.target.value })} aria-invalid={!!errors[i]?.id} />
                    {errors[i]?.id && <span className="text-xs text-destructive">{errors[i]!.id}</span>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Input
                      type="number"
                      step="0.01"
                      className="h-9"
                      value={Number.isNaN(r.amountYuan) ? "" : r.amountYuan}
                      onChange={(e) => patch(i, { amountYuan: e.target.value === "" ? NaN : Number(e.target.value) })}
                      aria-invalid={!!errors[i]?.amountYuan}
                    />
                    {errors[i]?.amountYuan && <span className="text-xs text-destructive">{errors[i]!.amountYuan}</span>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Input
                      type="number"
                      className="h-9"
                      value={Number.isNaN(r.credits) ? "" : r.credits}
                      onChange={(e) => patch(i, { credits: e.target.value === "" ? NaN : Number(e.target.value) })}
                      aria-invalid={!!errors[i]?.credits}
                    />
                    {errors[i]?.credits && <span className="text-xs text-destructive">{errors[i]!.credits}</span>}
                  </div>
                  <span className="whitespace-nowrap pt-2 text-xs text-muted-foreground">
                    {unit === null ? "—" : `¥${unit.toFixed(1)} / 100 积分`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mt-0.5"
                    aria-label="删除该档位"
                    onClick={() => setRows((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
            {formError && <span className="text-xs text-destructive">{formError}</span>}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setRows((prev) => [...(prev ?? []), { id: `pack_${Date.now()}`, amountYuan: 10, credits: 1000 }])}
            >
              <Plus data-icon="inline-start" />
              新增档位
            </Button>
            <p className="text-xs text-muted-foreground">
              档位 id 是用户下单时的凭据：改动等于作废旧入口，已发出的充值链接会失效——调价请改金额与积分，不要改 id。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
