"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save, RotateCcw } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
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
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { adminApi, AdminApiError, type ApiPlan } from "@/lib/admin-api"
import { ReferralConfigCard } from "@/components/admin/plans/referral-config-card"

// tab 名旁的"有未保存的更改"小圆点：不强拦切换，只是轻提示（spec327 反馈：单页塞两块配置太长，
// 拆成 tab 后容易忘记另一个 tab 还有未保存的编辑，需要一个不打断操作的信号）。
function UnsavedDot() {
  return <span className="size-1.5 rounded-full bg-amber-500" title="有未保存的更改" />
}

// 积分口径的 6 项真实能力（后端 config key = credit_cost.<op>），种子默认各 10 积分。
// 积分口径 9 项以 C 端 membership「积分消耗说明」为准（key 对齐后端 credit_cost.<key>）。
const CREDIT_COST_OPS: { key: string; label: string; desc: string }[] = [
  { key: "read", label: "招标解读", desc: "识别评分点与关键条款" },
  { key: "outline", label: "提纲生成", desc: "技术标 + 商务标大纲" },
  { key: "content_short", label: "标书生成（短篇）", desc: "单章 ≤ 2000 字" },
  { key: "content_long", label: "标书生成（长篇）", desc: "单章 > 2000 字" },
  { key: "rewrite", label: "逐章重写 / 改写", desc: "针对单章润色重写" },
  { key: "review", label: "废标风险审查", desc: "全文风险体检 + 整改建议" },
  { key: "dedupe", label: "标书查重", desc: "多维指纹比对" },
  { key: "present", label: "述标演示生成", desc: "标书提炼为述标/答辩 PPT" },
  { key: "export", label: "导出 Word / PDF", desc: "整本投标文件导出" },
]
const DEFAULT_CREDIT_COST = 10

const BILLING_CYCLE_LABELS: Record<string, string> = {
  month: "月付",
  quarter: "季付",
  year: "年付",
}

type CreditCosts = Record<string, number>

// 套餐表单行：价格用元展示编辑，提交时才 ×100 转分（Math.round，绝不存浮点分）。
type PlanForm = {
  id: string
  name: string
  code: string | null
  billingCycle: string
  priceYuan: number
  grantCreditsPerCycle: number
  features: Record<string, unknown>
}

// 权益中文标签（参考产品定价图）：仅展示已开启项。
export const FEATURE_LABELS: Record<string, string> = {
  export: "导出 Word/PDF",
  riskReview: "废标风险审查",
  dedupe: "标书查重",
  rewrite: "逐章重写/一键改写",
  fullDedupe: "全维度指纹查重",
  pptTemplate: "企业 PPT 模板",
  priorityQueue: "优先算力队列",
  longHistory: "历史项目长期保存",
}

function toCreditCosts(configs: Record<string, unknown>): CreditCosts {
  const costs: CreditCosts = {}
  for (const { key } of CREDIT_COST_OPS) {
    const v = configs[`credit_cost.${key}`]
    costs[key] = typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_CREDIT_COST
  }
  return costs
}

function toPlanForms(apiPlans: ApiPlan[]): PlanForm[] {
  return apiPlans.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    billingCycle: p.billingCycle,
    priceYuan: p.priceCents / 100,
    grantCreditsPerCycle: p.grantCreditsPerCycle,
    features: p.features ?? {},
  }))
}

export function PlansClient() {
  // 积分口径 costs：null 表示尚未加载完成（避免加载前误判 dirty）。
  const [costs, setCosts] = useState<CreditCosts | null>(null)
  const [savedCosts, setSavedCosts] = useState<CreditCosts | null>(null)
  const [planForms, setPlanForms] = useState<PlanForm[]>([])
  const [savedPlanForms, setSavedPlanForms] = useState<PlanForm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // 邀请奖励 tab 的 dirty 状态：完全封装在 ReferralConfigCard 自己的 hook 里，这里只接收
  // onDirtyChange 回调同步一份，供 tab 名旁的小圆点判断是否显示"有未保存的更改"。
  const [referralDirty, setReferralDirty] = useState(false)

  // 从真实后端拉取积分口径 + 套餐列表，mount 与 reset() 共用。
  async function loadData(isAlive: () => boolean) {
    setLoading(true)
    try {
      const [configs, apiPlans] = await Promise.all([
        adminApi.plans.getConfigs(),
        adminApi.plans.list(),
      ])
      if (!isAlive()) return
      const c = toCreditCosts(configs)
      setCosts(c)
      setSavedCosts(c)
      const pf = toPlanForms(apiPlans)
      setPlanForms(pf)
      setSavedPlanForms(pf)
    } catch {
      if (isAlive()) toast.error("加载套餐与积分口径配置失败")
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

  const dirty =
    costs !== null &&
    savedCosts !== null &&
    (JSON.stringify(costs) !== JSON.stringify(savedCosts) ||
      JSON.stringify(planForms) !== JSON.stringify(savedPlanForms))

  function updateCost(key: string, raw: string) {
    setCosts((prev) => {
      if (!prev) return prev
      const n = Math.max(0, Math.floor(Number(raw) || 0))
      return { ...prev, [key]: n }
    })
  }

  function updatePlanPrice(id: string, raw: string) {
    const n = Math.max(0, Number(raw) || 0)
    setPlanForms((prev) => prev.map((p) => (p.id === id ? { ...p, priceYuan: n } : p)))
  }

  function updatePlanCredits(id: string, raw: string) {
    const n = Math.max(0, Math.floor(Number(raw) || 0))
    setPlanForms((prev) =>
      prev.map((p) => (p.id === id ? { ...p, grantCreditsPerCycle: n } : p)),
    )
  }

  function updatePlanFeature(id: string, key: string, value: boolean) {
    setPlanForms((prev) => prev.map((p) => (p.id === id ? { ...p, features: { ...p.features, [key]: value } } : p)))
  }

  async function save() {
    if (!costs || !savedCosts) return
    setSaving(true)
    try {
      const changedCostOps = CREDIT_COST_OPS.filter(({ key }) => costs[key] !== savedCosts[key])
      const changedPlans = planForms.filter((p) => {
        const s = savedPlanForms.find((sp) => sp.id === p.id)
        return (
          !s ||
          s.priceYuan !== p.priceYuan ||
          s.grantCreditsPerCycle !== p.grantCreditsPerCycle ||
          JSON.stringify(s.features) !== JSON.stringify(p.features)
        )
      })
      await Promise.all([
        ...changedCostOps.map(({ key }) => adminApi.plans.setConfig(`credit_cost.${key}`, costs[key])),
        ...changedPlans.map((p) =>
          // 元→分：仅在此处 ×100 并 Math.round，从不存浮点分。features(权益开关)一并落库。
          adminApi.plans.update(p.id, {
            priceCents: Math.round(p.priceYuan * 100),
            grantCreditsPerCycle: p.grantCreditsPerCycle,
            features: p.features,
          }),
        ),
      ])
      setSavedCosts(costs)
      setSavedPlanForms(planForms)
      toast.success("配置已保存并生效", {
        description: "套餐档位与积分口径已更新，新规则即时对所有用户生效。",
      })
    } catch (e) {
      toast.error(
        e instanceof AdminApiError && e.status === 403
          ? "无权限：需要 plan.write / config.write 权限"
          : "保存失败，请重试",
      )
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    await loadData(() => true)
    toast.info("已还原为服务器上次保存的配置")
  }

  const disableActions = !dirty || saving || loading

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">套餐、积分与邀请奖励配置</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          配置化管理会员档位、各能力的积分消耗与邀请奖励规则，保存后即时生效。
        </p>
      </div>

      {/* 两个面板都 keepMounted：默认行为下 base-ui Tabs 切走会把面板整个卸载。「套餐与积分」
         这半的 dirty 状态本就存在 Tabs 外层的本组件里，卸载面板不丢状态；但「邀请奖励」半的
         dirty/编辑态完全封装在 ReferralConfigCard 自己的 hook 里，若面板被卸载会连带把 hook
         state 一起销毁重建——重新拉一次接口、丢掉用户还没保存的修改。keepMounted 让切换只是
         hidden 属性（CSS 隐藏），不卸载组件树，两个 tab 各自的编辑态因此都不受切换影响。 */}
      <Tabs defaultValue="plans-credits">
        <TabsList>
          <TabsTrigger value="plans-credits" className="gap-1.5">
            套餐与积分
            {dirty && <UnsavedDot />}
          </TabsTrigger>
          <TabsTrigger value="referral" className="gap-1.5">
            邀请奖励
            {referralDirty && <UnsavedDot />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="plans-credits" keepMounted className="mt-4 flex flex-col gap-6">
          <div className="flex items-center justify-end gap-2">
            {dirty && (
              <Badge variant="secondary" className="font-normal">
                有未保存的更改
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={reset} disabled={disableActions}>
              <RotateCcw data-icon="inline-start" />
              还原
            </Button>
            <Button size="sm" onClick={save} disabled={disableActions}>
              <Save data-icon="inline-start" />
              保存并生效
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>会员档位</CardTitle>
              <CardDescription>价格与每周期赠送积分，按套餐+计费周期逐行展示。</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {loading ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : planForms.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无套餐，去数据库/种子创建</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-24">档位</TableHead>
                      <TableHead>代码</TableHead>
                      <TableHead>计费周期</TableHead>
                      <TableHead>价格(元)</TableHead>
                      <TableHead>每周期赠送积分</TableHead>
                      <TableHead className="min-w-64">权限</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {planForms.map((plan) => (
                      <TableRow key={plan.id}>
                        <TableCell className="font-medium text-foreground">{plan.name}</TableCell>
                        <TableCell className="text-muted-foreground">{plan.code ?? "-"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {BILLING_CYCLE_LABELS[plan.billingCycle] ?? plan.billingCycle}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            className="h-9 w-28"
                            value={plan.priceYuan}
                            onChange={(e) => updatePlanPrice(plan.id, e.target.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            className="h-9 w-28"
                            value={plan.grantCreditsPerCycle}
                            onChange={(e) => updatePlanCredits(plan.id, e.target.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                            {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                              <label key={key} className="flex items-center gap-2 text-xs">
                                <Switch checked={plan.features[key] === true} onCheckedChange={(v) => updatePlanFeature(plan.id, key, v)} />
                                <span className="text-muted-foreground">{label}</span>
                              </label>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>积分消耗口径</CardTitle>
              <CardDescription>
                每项能力调用所扣减的积分值，支持随时调整。修改后立即应用于后续调用。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading || !costs ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : (
                <div className="grid gap-x-8 sm:grid-cols-2">
                  {CREDIT_COST_OPS.map((op, i) => (
                    <div key={op.key}>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">{op.label}</span>
                          <span className="text-xs text-muted-foreground">{op.desc}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            className="h-9 w-24 text-right"
                            value={costs[op.key]}
                            onChange={(e) => updateCost(op.key, e.target.value)}
                          />
                          <span className="text-sm text-muted-foreground">积分</span>
                        </div>
                      </div>
                      {i < CREDIT_COST_OPS.length - 1 && <Separator />}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="referral" keepMounted className="mt-4">
          <ReferralConfigCard onDirtyChange={setReferralDirty} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
