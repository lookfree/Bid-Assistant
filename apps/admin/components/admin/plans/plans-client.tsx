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
import { adminApi, AdminApiError, type ApiPlan } from "@/lib/admin-api"

// 积分口径的 6 项真实能力（后端 config key = credit_cost.<op>），种子默认各 10 积分。
const CREDIT_COST_OPS: { key: string; label: string; desc: string }[] = [
  { key: "read", label: "读标", desc: "解析招标文件并提取要点" },
  { key: "outline", label: "提纲", desc: "生成投标文件章节提纲" },
  { key: "content", label: "正文", desc: "生成投标文件正文内容" },
  { key: "review", label: "审查", desc: "废标风险点扫描" },
  { key: "present", label: "述标", desc: "生成述标 PPT" },
  { key: "export", label: "导出", desc: "导出为 Word / PDF" },
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
export function enabledFeatureLabels(features: Record<string, unknown>): string[] {
  return Object.keys(FEATURE_LABELS).filter((k) => features[k] === true).map((k) => FEATURE_LABELS[k])
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

// 智能体模型配置（spec311）：provider/model/fallbacks，model 允许留空回落服务商默认。
export type AgentModelForm = { provider: string; model: string; fallbacks: string }

export const PROVIDER_OPTIONS = [
  { value: "deepseek", label: "DeepSeek" },
  { value: "qwen", label: "阿里千问（通义千问）" },
  { value: "glm", label: "智谱 GLM" },
]

// config 值（model 可能为 null/缺省）→ 表单：null/非字符串一律规整为空串。
export function toAgentModelForm(cfg: unknown): AgentModelForm {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>
  return {
    // 未知/缺失 provider 兜底为 deepseek（默认家），不报错
    provider: typeof c.provider === "string" ? c.provider : "deepseek",
    model: typeof c.model === "string" ? c.model : "",
    fallbacks: typeof c.fallbacks === "string" ? c.fallbacks : "",
  }
}

// 表单 → config 值：空 model 回写 null（表示回落服务商默认模型）。
export function fromAgentModelForm(
  f: AgentModelForm,
): { provider: string; model: string | null; fallbacks: string } {
  return { provider: f.provider, model: f.model === "" ? null : f.model, fallbacks: f.fallbacks }
}

export function PlansClient() {
  // 积分口径 costs：null 表示尚未加载完成（避免加载前误判 dirty）。
  const [costs, setCosts] = useState<CreditCosts | null>(null)
  const [savedCosts, setSavedCosts] = useState<CreditCosts | null>(null)
  const [planForms, setPlanForms] = useState<PlanForm[]>([])
  const [savedPlanForms, setSavedPlanForms] = useState<PlanForm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">套餐与积分口径配置</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            配置化管理会员档位与各能力的积分消耗，保存后即时生效。
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <AgentModelCard />
    </div>
  )
}

// 智能体模型配置卡片（spec311）：接 spec310 后端 GET/PUT /plans/configs（真实 admin-api，非本页其余区块的
// mock-data 保存模式）。加载态/保存态独立于套餐&积分区，避免相互影响。
function AgentModelCard() {
  const [form, setForm] = useState<AgentModelForm>({
    provider: "deepseek",
    model: "",
    fallbacks: "",
  })
  const [saved, setSaved] = useState<AgentModelForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    adminApi.plans
      .getConfigs()
      .then((configs) => {
        if (!alive) return
        const f = toAgentModelForm(configs.agent_model)
        setForm(f)
        setSaved(f)
      })
      .catch(() => alive && toast.error("加载智能体模型配置失败"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const dirty = saved !== null && JSON.stringify(form) !== JSON.stringify(saved)

  async function save() {
    setSaving(true)
    try {
      await adminApi.plans.setConfig("agent_model", fromAgentModelForm(form))
      setSaved(form)
      toast.success("智能体模型配置已保存并生效")
    } catch (e) {
      // 无 config.write 权限的角色（如 support）会收到 403：这里没有前端权限清单可提前禁用按钮，
      // 只能在保存时按状态码区分提示（与后端 requirePermission("config.write") 语义对齐）。
      toast.error(
        e instanceof AdminApiError && e.status === 403
          ? "无权限：需要 config.write 权限"
          : "保存失败，请重试",
      )
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    if (saved) setForm(saved)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>智能体模型</CardTitle>
        <CardDescription>
          配置投标智能体调用的模型服务商、模型名与降级候选，保存后立即生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <>
            <AgentModelFields form={form} onChange={setForm} />
            <AgentModelActions dirty={dirty} saving={saving} onReset={reset} onSave={save} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

// 保存/还原工具条（未保存标记 + 按钮禁用态），抽出以控制 AgentModelCard 行数。
function AgentModelActions({
  dirty,
  saving,
  onReset,
  onSave,
}: {
  dirty: boolean
  saving: boolean
  onReset: () => void
  onSave: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      {dirty && (
        <Badge variant="secondary" className="font-normal">
          有未保存的更改
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onReset} disabled={!dirty || saving}>
          <RotateCcw data-icon="inline-start" />
          还原
        </Button>
        <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
          <Save data-icon="inline-start" />
          保存并生效
        </Button>
      </div>
    </div>
  )
}

// 三个字段的表单区（provider 下拉 + model/fallbacks 文本框），抽出以控制 AgentModelCard 行数。
function AgentModelFields({
  form,
  onChange,
}: {
  form: AgentModelForm
  onChange: (updater: (f: AgentModelForm) => AgentModelForm) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground">服务商</label>
        <select
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={form.provider}
          onChange={(e) => {
            const provider = e.target.value
            onChange((f) => ({ ...f, provider }))
          }}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground">模型名</label>
        <Input
          placeholder="留空使用服务商默认模型"
          value={form.model}
          onChange={(e) => {
            const model = e.target.value
            onChange((f) => ({ ...f, model }))
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground">降级候选</label>
        <Input
          placeholder="如 glm:glm-4-flash"
          value={form.fallbacks}
          onChange={(e) => {
            const fallbacks = e.target.value
            onChange((f) => ({ ...f, fallbacks }))
          }}
        />
      </div>
    </div>
  )
}
