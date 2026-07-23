"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save, RotateCcw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import { toReferralRules, toReferralRulesPayload, validateReferralRules, type ReferralRules, type ReferralRulesErrors } from "@/lib/referral-config"

// base-ui 的 Select 不接受空字符串 value（unlockOn=""＝立即发放），用哨兵值映射，
// 提交/展示前再与真实取值互转，不改变 referral_rules 里存的实际字段值。
const UNLOCK_IMMEDIATE = "immediate"
const UNLOCK_ON_OPTIONS = [
  { value: UNLOCK_IMMEDIATE, label: "被邀请人注册即发放" },
  { value: "invitee_first_paid", label: "充值 / 开通会员即发放" },
]

// 展示的数值字段（abandonDays 注册即弃、reward_expire_days 有效期都用默认，不在页面展示）。
type NumericKey = "inviterReward" | "inviteeReward" | "capPerUser" | "riskMaxPerIpPerHour"
const NUMERIC_FIELDS: { key: NumericKey; label: string }[] = [
  { key: "inviterReward", label: "邀请人奖励（积分/单）" },
  { key: "inviteeReward", label: "被邀请人奖励（积分）" },
  { key: "capPerUser", label: "单用户累计封顶（积分）" },
  { key: "riskMaxPerIpPerHour", label: "同 IP 每小时绑定阈值" },
]

// 数值输入展示：NaN（空输入/非法输入）展示为空字符串，避免控件里出现字面量 "NaN"。
function displayValue(n: number): number | string {
  return Number.isNaN(n) ? "" : n
}

// 邀请奖励规则的状态编排（load/dirty/save/reset）。有效期/注册即弃保持配置默认，不在本卡编辑。
function useReferralConfigState() {
  const [rules, setRules] = useState<ReferralRules | null>(null)
  const [savedRules, setSavedRules] = useState<ReferralRules | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  async function loadData(isAlive: () => boolean) {
    setLoading(true)
    try {
      const r = toReferralRules(await adminApi.plans.getConfigs())
      if (!isAlive()) return
      setRules(r)
      setSavedRules(r)
    } catch {
      if (isAlive()) toast.error("加载邀请奖励配置失败")
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

  const dirty = rules !== null && savedRules !== null && JSON.stringify(rules) !== JSON.stringify(savedRules)

  // 保存 referral_rules（未展示的 abandonDays/有效期沿用加载值一并提交，值不变则无副作用）。
  async function save() {
    if (!rules || !savedRules) return
    setSaving(true)
    try {
      await adminApi.plans.setConfig("referral_rules", toReferralRulesPayload(rules))
      setSavedRules(rules)
      toast.success("配置已保存并生效", { description: "新规则即时生效，仅影响此后发放，历史奖励流水不受影响。" })
    } catch (e) {
      const perm = e instanceof AdminApiError && e.status === 403
      toast.error(perm ? "无权限：需要 config.write 权限" : "保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    await loadData(() => true)
    toast.info("已还原为服务器上次保存的配置")
  }

  return { rules, setRules, loading, saving, dirty, save, reset }
}

// onDirtyChange：可选，供 plans-client.tsx 的 tab 名旁小圆点感知本卡是否有未保存的更改。
export function ReferralConfigCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { rules, setRules, loading, saving, dirty, save, reset } = useReferralConfigState()

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const ruleErrors = rules ? validateReferralRules(rules) : {}
  const hasErrors = Object.keys(ruleErrors).length > 0

  function updateField(key: NumericKey, raw: string) {
    setRules((prev) => (prev ? { ...prev, [key]: raw === "" ? NaN : Number(raw) } : prev))
  }
  function updateUnlockOn(v: string) {
    setRules((prev) => (prev ? { ...prev, unlockOn: v === "invitee_first_paid" ? "invitee_first_paid" : "" } : prev))
  }

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
          <CardTitle>邀请奖励配置</CardTitle>
          <CardDescription>邀请奖励发放规则，保存后新规则即时生效，仅影响此后发放。</CardDescription>
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
      <CardContent className="flex flex-col gap-5">
        {loading || !rules ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <ReferralFieldsGrid rules={rules} ruleErrors={ruleErrors} onFieldChange={updateField} onUnlockOnChange={updateUnlockOn} />
        )}
      </CardContent>
    </Card>
  )
}

// 表单主体：四个数值字段 + 发放时机下拉。从 ReferralConfigCard 拆出，两者都在可读行数内。
function ReferralFieldsGrid({
  rules,
  ruleErrors,
  onFieldChange,
  onUnlockOnChange,
}: {
  rules: ReferralRules
  ruleErrors: ReferralRulesErrors
  onFieldChange: (key: NumericKey, raw: string) => void
  onUnlockOnChange: (v: string) => void
}) {
  return (
    <>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {NUMERIC_FIELDS.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <Input
              type="number"
              className="h-9 w-full"
              value={displayValue(rules[key])}
              onChange={(e) => onFieldChange(key, e.target.value)}
              aria-invalid={!!ruleErrors[key]}
            />
            {ruleErrors[key] && <span className="text-xs text-destructive">{ruleErrors[key]}</span>}
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">奖励发放时机</span>
          <Select
            items={UNLOCK_ON_OPTIONS}
            value={rules.unlockOn === "invitee_first_paid" ? "invitee_first_paid" : UNLOCK_IMMEDIATE}
            onValueChange={(v) => v && onUnlockOnChange(v)}
          >
            <SelectTrigger className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNLOCK_ON_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ruleErrors.unlockOn && <span className="text-xs text-destructive">{ruleErrors.unlockOn}</span>}
        </div>
      </div>
      <Separator />
      <p className="text-xs text-muted-foreground">单用户累计奖励达封顶后不再继续发放；「发放时机」决定是好友注册即发，还是好友首次充值/开通会员后再发。</p>
    </>
  )
}
