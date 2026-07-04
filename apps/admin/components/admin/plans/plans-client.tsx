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
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import {
  planConfigs as seedPlans,
  pointRules as seedRules,
  type PlanConfig,
  type PointRule,
} from "@/lib/mock-data"

const featureLabels: Record<keyof PlanConfig["features"], string> = {
  rewrite: "智能重写",
  dedupe: "查重检测",
  export: "高级导出",
  priority: "优先队列",
}
const featureKeys = Object.keys(featureLabels) as (keyof PlanConfig["features"])[]

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
  const [plans, setPlans] = useState<PlanConfig[]>(() =>
    seedPlans.map((p) => ({ ...p, features: { ...p.features } })),
  )
  const [rules, setRules] = useState<PointRule[]>(() =>
    seedRules.map((r) => ({ ...r })),
  )
  const [dirty, setDirty] = useState(false)

  function updatePlan(tier: string, patch: Partial<PlanConfig>) {
    setPlans((prev) =>
      prev.map((p) => (p.tier === tier ? { ...p, ...patch } : p)),
    )
    setDirty(true)
  }

  function updateFeature(
    tier: string,
    key: keyof PlanConfig["features"],
    value: boolean,
  ) {
    setPlans((prev) =>
      prev.map((p) =>
        p.tier === tier
          ? { ...p, features: { ...p.features, [key]: value } }
          : p,
      ),
    )
    setDirty(true)
  }

  function updateRule(key: string, cost: number) {
    setRules((prev) => prev.map((r) => (r.key === key ? { ...r, cost } : r)))
    setDirty(true)
  }

  function save() {
    setDirty(false)
    toast.success("配置已保存并生效", {
      description: "套餐档位与积分口径已更新，新规则即时对所有用户生效。",
    })
  }

  function reset() {
    setPlans(seedPlans.map((p) => ({ ...p, features: { ...p.features } })))
    setRules(seedRules.map((r) => ({ ...r })))
    setDirty(false)
    toast.info("已还原为上次保存的配置")
  }

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
          <Button variant="outline" size="sm" onClick={reset} disabled={!dirty}>
            <RotateCcw data-icon="inline-start" />
            还原
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty}>
            <Save data-icon="inline-start" />
            保存并生效
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>会员档位</CardTitle>
          <CardDescription>
            价格、周期、每月赠送积分、并行项目数与权益开关。
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-24">档位</TableHead>
                <TableHead>月付价(￥)</TableHead>
                <TableHead>年付价(￥)</TableHead>
                <TableHead>每月赠送积分</TableHead>
                <TableHead>并行项目数</TableHead>
                {featureKeys.map((k) => (
                  <TableHead key={k} className="text-center">
                    {featureLabels[k]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.tier}>
                  <TableCell className="font-medium text-foreground">
                    {plan.name}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      className="h-9 w-24"
                      value={plan.monthly}
                      onChange={(e) =>
                        updatePlan(plan.tier, { monthly: Number(e.target.value) })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      className="h-9 w-24"
                      value={plan.yearly}
                      onChange={(e) =>
                        updatePlan(plan.tier, { yearly: Number(e.target.value) })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      className="h-9 w-28"
                      value={plan.monthlyPoints}
                      onChange={(e) =>
                        updatePlan(plan.tier, {
                          monthlyPoints: Number(e.target.value),
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      className="h-9 w-20"
                      value={plan.parallelProjects}
                      onChange={(e) =>
                        updatePlan(plan.tier, {
                          parallelProjects: Number(e.target.value),
                        })
                      }
                    />
                  </TableCell>
                  {featureKeys.map((k) => (
                    <TableCell key={k} className="text-center">
                      <div className="flex justify-center">
                        <Switch
                          checked={plan.features[k]}
                          onCheckedChange={(v) => updateFeature(plan.tier, k, v)}
                        />
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
          <div className="grid gap-x-8 sm:grid-cols-2">
            {rules.map((rule, i) => (
              <div key={rule.key}>
                <div className="flex items-center justify-between gap-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {rule.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{rule.desc}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="h-9 w-24 text-right"
                      value={rule.cost}
                      onChange={(e) => updateRule(rule.key, Number(e.target.value))}
                    />
                    <span className="text-sm text-muted-foreground">积分</span>
                  </div>
                </div>
                {i < rules.length - 1 && <Separator />}
              </div>
            ))}
          </div>
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
