"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save, RotateCcw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import { toSignupGrantValues, validateSignupGrant, type SignupGrantValues } from "@/lib/signup-grant-config"

// 两个数值字段的展示元数据（key 即配置存储字段）。
const FIELDS: { key: keyof SignupGrantValues; configKey: string; label: string; hint: string }[] = [
  { key: "credits", configKey: "signup_grant_credits", label: "注册赠送积分", hint: "0 = 不赠送" },
  { key: "expireDays", configKey: "grant_expire_days", label: "赠送积分有效期（天）", hint: "0 = 不过期" },
]

// 注册赠送配置的状态编排（load/dirty/save/reset）：照 referral-config-card 的 hook 分层惯例。
function useSignupGrantState() {
  const [values, setValues] = useState<SignupGrantValues | null>(null)
  const [saved, setSaved] = useState<SignupGrantValues | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  async function loadData(isAlive: () => boolean) {
    setLoading(true)
    try {
      const v = toSignupGrantValues(await adminApi.plans.getConfigs())
      if (!isAlive()) return
      setValues(v)
      setSaved(v)
    } catch {
      if (isAlive()) toast.error("加载注册赠送配置失败")
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

  const dirty = values !== null && saved !== null && (values.credits !== saved.credits || values.expireDays !== saved.expireDays)

  // 只提交实际变化的键，避免对未改动键产生无意义审计记录；失败保留编辑态便于重试。
  async function save() {
    if (!values || !saved) return
    setSaving(true)
    try {
      for (const f of FIELDS) {
        if (values[f.key] !== saved[f.key]) await adminApi.plans.setConfig(f.configKey, values[f.key])
      }
      setSaved(values)
      toast.success("注册赠送配置已保存并生效", { description: "仅影响此后注册的新用户，已发放的赠送不受影响。" })
    } catch (e) {
      toast.error(e instanceof AdminApiError && e.status === 403 ? "无权限：需要 config.write 权限" : "保存失败，请重试，当前编辑内容已保留")
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    await loadData(() => true)
    toast.info("已还原为服务器上次保存的配置")
  }

  return { values, setValues, loading, saving, dirty, save, reset }
}

// onDirtyChange：供 plans-client 的 tab 名旁小圆点感知本卡是否有未保存更改。
export function SignupGrantCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { values, setValues, loading, saving, dirty, save, reset } = useSignupGrantState()

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const errors = values ? validateSignupGrant(values) : {}
  const hasErrors = Object.keys(errors).length > 0

  async function onSave() {
    if (hasErrors) {
      toast.error("请先修正标红字段")
      return
    }
    await save()
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>注册赠送</CardTitle>
          <CardDescription>新用户首次注册一次性赠送的积分额度与有效期，每用户仅发一次。</CardDescription>
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
          <Button size="sm" onClick={onSave} disabled={!dirty || saving || loading || hasErrors}>
            <Save data-icon="inline-start" />
            保存并生效
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !values ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">{f.label}</span>
                <Input
                  type="number"
                  className="h-9 w-full"
                  value={Number.isNaN(values[f.key]) ? "" : values[f.key]}
                  onChange={(e) => setValues((prev) => (prev ? { ...prev, [f.key]: e.target.value === "" ? NaN : Number(e.target.value) } : prev))}
                  aria-invalid={!!errors[f.key]}
                />
                {errors[f.key] ? (
                  <span className="text-xs text-destructive">{errors[f.key]}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{f.hint}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
