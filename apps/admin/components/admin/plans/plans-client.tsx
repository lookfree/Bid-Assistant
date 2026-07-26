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
import { SignupGrantCard } from "@/components/admin/plans/signup-grant-card"

// tab 名旁的"有未保存的更改"小圆点：不强拦切换，只是轻提示（spec327 反馈：单页塞两块配置太长，
// 拆成 tab 后容易忘记另一个 tab 还有未保存的编辑，需要一个不打断操作的信号）。
function UnsavedDot() {
  return <span className="size-1.5 rounded-full bg-amber-500" title="有未保存的更改" />
}

// 积分口径的 6 项真实能力（后端 config key = credit_cost.<op>），种子默认各 10 积分。
// 积分口径 7 项以 C 端 membership「积分消耗说明」为准（key 对齐后端 credit_cost.<key>）；
// 标书生成不在此列——它走下方的按字数分档阶梯（credit_cost.content_tiers）。
const CREDIT_COST_OPS: { key: string; label: string; desc: string }[] = [
  { key: "read", label: "招标解读", desc: "识别评分点与关键条款" },
  { key: "outline", label: "提纲生成", desc: "技术标 + 商务标大纲" },
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

/** 标书生成计费阶梯；maxChars=null 为顶档（无上限，不可删）。 */
type ContentTier = { maxChars: number | null; cost: number }

// 仅在 credit_cost.content_tiers 配置缺失/为空时兜底展示，绝不代替真实加载值（数字一律来自后端配置）。
const DEFAULT_TIERS: ContentTier[] = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

/** 阶梯合法性（与后端 parseContentTiers 同规则）：非法时就地报错、不发请求。 */
function tiersError(tiers: ContentTier[]): string | null {
  if (tiers.length === 0) return "至少要有一档"
  if (tiers.some((t) => !Number.isInteger(t.cost) || t.cost < 0)) return "积分必须是 ≥0 的整数"
  if (tiers.some((t) => t.maxChars !== null && (!Number.isInteger(t.maxChars) || t.maxChars <= 0)))
    return "字数上限必须是正整数"
  if (tiers.filter((t) => t.maxChars === null).length !== 1) return "必须有且只有一个顶档"
  const b = tiers.filter((t) => t.maxChars !== null).map((t) => t.maxChars as number)
  if (new Set(b).size !== b.length) return "字数上限不可重复"
  return null
}

/** 提交前规范化：按字数上限升序，顶档置于末位（与后端返回顺序一致）。 */
function sortTiers(tiers: ContentTier[]): ContentTier[] {
  const bounded = tiers.filter((t) => t.maxChars !== null).sort((a, b) => (a.maxChars as number) - (b.maxChars as number))
  return [...bounded, ...tiers.filter((t) => t.maxChars === null)]
}

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
  // 标书生成计费阶梯：null 同样表示尚未加载完成（与 costs 同一套 dirty 判定习惯）。
  const [tiers, setTiers] = useState<ContentTier[] | null>(null)
  const [savedTiers, setSavedTiers] = useState<ContentTier[] | null>(null)
  const [planForms, setPlanForms] = useState<PlanForm[]>([])
  const [savedPlanForms, setSavedPlanForms] = useState<PlanForm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // 邀请奖励 tab 的 dirty 状态：完全封装在 ReferralConfigCard 自己的 hook 里，这里只接收
  // onDirtyChange 回调同步一份，供 tab 名旁的小圆点判断是否显示"有未保存的更改"。
  const [referralDirty, setReferralDirty] = useState(false)
  // 注册赠送卡同理：自带保存/还原，这里只镜像 dirty 供 tab 圆点显示。
  const [signupDirty, setSignupDirty] = useState(false)

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
      // 阶梯配置缺失/为空时兜底为 DEFAULT_TIERS，仅用于此种兜底场景，不覆盖真实加载值。
      const rawTiers = configs["credit_cost.content_tiers"]
      const loadedTiers = Array.isArray(rawTiers) && rawTiers.length > 0 ? (rawTiers as ContentTier[]) : DEFAULT_TIERS
      setTiers(loadedTiers)
      setSavedTiers(loadedTiers)
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
      JSON.stringify(planForms) !== JSON.stringify(savedPlanForms) ||
      JSON.stringify(tiers) !== JSON.stringify(savedTiers))

  // 阶梯校验错误（与后端 parseContentTiers 同规则）：非法时禁用保存按钮，而非等后端 400 才发现。
  const tiersErr = tiers ? tiersError(tiers) : null

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
    // 阶梯校验兜底：正常情况下保存按钮已因 tiersErr 禁用，这里防御性拦截一次，避免坏值发到后端 400。
    if (tiersErr) {
      toast.error(`计费阶梯不合法：${tiersErr}`)
      return
    }
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
      const tiersChanged = tiers && JSON.stringify(tiers) !== JSON.stringify(savedTiers)
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
        ...(tiersChanged ? [adminApi.plans.setConfig("credit_cost.content_tiers", sortTiers(tiers!))] : []),
      ])
      setSavedCosts(costs)
      setSavedPlanForms(planForms)
      // 落库的是 sortTiers(tiers)：同步把排序结果写回 tiers 本身（不只是 savedTiers），否则
      // "+ 增加一档"追加在末尾（顶档之后）导致 tiers 顺序 ≠ savedTiers 顺序——内容相同但
      // JSON.stringify 比较因顺序不同恒为 true，dirty 永远清不掉、每次保存都重复 PUT 同一份阶梯。
      if (tiersChanged) {
        const sorted = sortTiers(tiers!)
        setTiers(sorted)
        setSavedTiers(sorted)
      }
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
            {(dirty || signupDirty) && <UnsavedDot />}
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
            <Button size="sm" onClick={save} disabled={disableActions || !!tiersErr}>
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

              {/* 标书生成按产出总字数分档计费（credit_cost.content_tiers），顶档（maxChars=null）不可删。 */}
              <div className="mt-6 border-t pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">标书生成（按产出总字数分档）</span>
                    <span className="text-xs text-muted-foreground">
                      一次生成整本标书计一次费；按实际产出的正文总字数落档（总字数 ≤ 上限即取该档）
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || !tiers}
                    onClick={() => setTiers((prev) => [...(prev ?? []), { maxChars: 10_000, cost: 10 }])}
                  >
                    + 增加一档
                  </Button>
                </div>
                {loading || !tiers ? (
                  <p className="mt-3 text-sm text-muted-foreground">加载中…</p>
                ) : (
                  <div className="mt-3 flex flex-col gap-2">
                    {tiers.map((t, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">总字数 ≤</span>
                          {t.maxChars === null ? (
                            <span className="w-32 text-sm font-medium text-foreground">不限（顶档）</span>
                          ) : (
                            <Input
                              type="number"
                              className="h-9 w-32 text-right"
                              value={t.maxChars}
                              onChange={(e) =>
                                setTiers((prev) =>
                                  (prev ?? []).map((x, j) =>
                                    j === i ? { ...x, maxChars: Math.trunc(Number(e.target.value)) || 0 } : x,
                                  ),
                                )
                              }
                            />
                          )}
                          <span className="text-sm text-muted-foreground">字 →</span>
                          <Input
                            type="number"
                            className="h-9 w-24 text-right"
                            value={t.cost}
                            onChange={(e) =>
                              setTiers((prev) =>
                                (prev ?? []).map((x, j) =>
                                  j === i ? { ...x, cost: Math.trunc(Number(e.target.value)) || 0 } : x,
                                ),
                              )
                            }
                          />
                          <span className="text-sm text-muted-foreground">积分</span>
                          {t.maxChars !== null && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setTiers((prev) => (prev ?? []).filter((_, j) => j !== i))}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                        {/* 清空 cost 输入框与显式填 0 在数值上无法区分（都存成合法的 0=免费档）；
                           这里只做提示不拦截保存，避免误清空静默落库成免费档却无人察觉。 */}
                        {t.cost === 0 && (
                          <p className="text-xs text-amber-600">该档积分为 0，请确认并非误清空</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {tiersErr && <p className="mt-2 text-xs text-destructive">{tiersErr}</p>}
              </div>
            </CardContent>
          </Card>

          <SignupGrantCard onDirtyChange={setSignupDirty} />
        </TabsContent>

        <TabsContent value="referral" keepMounted className="mt-4">
          <ReferralConfigCard onDirtyChange={setReferralDirty} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
