"use client"

import { useState } from "react"
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
    </div>
  )
}
