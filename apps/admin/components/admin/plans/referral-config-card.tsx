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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import {
  toReferralRules,
  toRewardExpireDays,
  toReferralRulesPayload,
  validateReferralRules,
  validateRewardExpireDays,
  type ReferralRules,
  type ReferralRulesErrors,
} from "@/lib/referral-config"

// base-ui 的 Select 不接受空字符串 value（unlockOn=""＝立即发放），用哨兵值映射，
// 提交/展示前再与真实取值互转，不改变 referral_rules 里存的实际字段值。
const UNLOCK_IMMEDIATE = "immediate"
const UNLOCK_ON_OPTIONS = [
  { value: UNLOCK_IMMEDIATE, label: "被邀请人注册即发放" },
  { value: "invitee_first_paid", label: "充值/开通会员即发放" },
]

// 五个数值字段的展示元数据（unlockOn 是下拉框，reward_expire_days 是独立键，单独渲染）。
type NumericKey = keyof Omit<ReferralRules, "unlockOn">
const NUMERIC_FIELDS: { key: NumericKey; label: string }[] = [
  { key: "inviterReward", label: "邀请人奖励（积分/单）" },
  { key: "inviteeReward", label: "被邀请人奖励（积分）" },
  { key: "capPerUser", label: "单用户累计封顶（积分）" },
  { key: "riskMaxPerIpPerHour", label: "同 IP 每小时绑定阈值" },
  { key: "abandonDays", label: "注册即弃判定（天）" },
]

// 数值输入展示：NaN（空输入/非法输入）展示为空字符串，避免控件里出现字面量 "NaN"。
function displayValue(n: number): number | string {
  return Number.isNaN(n) ? "" : n
}

// 拉取 referral_rules + reward_expire_days 并做兜底转换（独立小函数，供状态 hook 复用）。
async function fetchReferralConfig(): Promise<{ rules: ReferralRules; expireDays: number }> {
  const configs = await adminApi.plans.getConfigs()
  return { rules: toReferralRules(configs), expireDays: toRewardExpireDays(configs) }
}

// 邀请奖励配置的状态编排（load/dirty/save/reset）：从渲染逻辑中拆出，照抄 model-card.tsx
// 的 useDraftTest 分层惯例——state-heavy 逻辑放 hook，组件函数只管渲染，两者各自 ≤80 行。
function useReferralConfigState() {
  const [rules, setRules] = useState<ReferralRules | null>(null)
  const [savedRules, setSavedRules] = useState<ReferralRules | null>(null)
  const [expireDays, setExpireDays] = useState<number | null>(null)
  const [savedExpireDays, setSavedExpireDays] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  async function loadData(isAlive: () => boolean) {
    setLoading(true)
    try {
      const { rules: r, expireDays: d } = await fetchReferralConfig()
      if (!isAlive()) return
      setRules(r)
      setSavedRules(r)
      setExpireDays(d)
      setSavedExpireDays(d)
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

  const dirty =
    rules !== null &&
    savedRules !== null &&
    expireDays !== null &&
    savedExpireDays !== null &&
    (JSON.stringify(rules) !== JSON.stringify(savedRules) || expireDays !== savedExpireDays)

  // 两个 PUT 串行：先 referral_rules 后 reward_expire_days；只提交实际变化的键，避免
  // 对未改动的键产生无意义的审计记录。失败时保留当前编辑态，不回滚，方便运营重试。
  async function save() {
    if (!rules || !savedRules || expireDays === null || savedExpireDays === null) return
    setSaving(true)
    try {
      if (JSON.stringify(rules) !== JSON.stringify(savedRules)) {
        await adminApi.plans.setConfig("referral_rules", toReferralRulesPayload(rules))
      }
      if (expireDays !== savedExpireDays) {
        await adminApi.plans.setConfig("reward_expire_days", expireDays)
      }
      setSavedRules(rules)
      setSavedExpireDays(expireDays)
      toast.success("配置已保存并生效", {
        description: "新规则即时生效，仅影响此后发放，历史奖励流水不受影响。",
      })
    } catch (e) {
      toast.error(
        e instanceof AdminApiError && e.status === 403
          ? "无权限：需要 config.write 权限"
          : "保存失败，请重试，当前编辑内容已保留",
      )
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    await loadData(() => true)
    toast.info("已还原为服务器上次保存的配置")
  }

  return { rules, setRules, expireDays, setExpireDays, loading, saving, dirty, save, reset }
}

// onDirtyChange：可选，供 plans-client.tsx 的 tab 名旁小圆点感知本卡是否有未保存的更改
// （本卡的 dirty 状态完全封装在 useReferralConfigState 里，父组件只能通过回调拿到一份镜像）。
export function ReferralConfigCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { rules, setRules, expireDays, setExpireDays, loading, saving, dirty, save, reset } =
    useReferralConfigState()

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 本地校验与服务端同规则，提前拦截（服务端 400 无字段明细，无法逐字段定位）。
  const ruleErrors = rules ? validateReferralRules(rules) : {}
  const expireError = expireDays !== null ? validateRewardExpireDays(expireDays) : undefined
  const hasErrors = Object.keys(ruleErrors).length > 0 || !!expireError

  function updateField(key: NumericKey, raw: string) {
    // 不做 Math.max(0,...) 式的静默纠正：非法值（负数/小数/空）原样存入 state，交给
    // validateReferralRules 逐字段标红提示，否则用户永远看不到自己填了非法值。
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
          <CardDescription>
            邀请奖励发放规则（referral_rules）与奖励积分有效期，保存后新规则即时生效，仅影响此后发放。
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
          <Button size="sm" onClick={onSave} disabled={!dirty || saving || loading || hasErrors}>
            <Save data-icon="inline-start" />
            保存并生效
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {loading || !rules || expireDays === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <ReferralFieldsGrid
            rules={rules}
            expireDays={expireDays}
            ruleErrors={ruleErrors}
            expireError={expireError}
            onFieldChange={updateField}
            onUnlockOnChange={updateUnlockOn}
            onExpireDaysChange={(raw) => setExpireDays(raw === "" ? NaN : Number(raw))}
          />
        )}
      </CardContent>
    </Card>
  )
}

// 表单主体：五个数值字段 + unlockOn 下拉 + reward_expire_days，外加只读提示区。
// 从 ReferralConfigCard 拆出，保持两者都在可读的行数范围内。
function ReferralFieldsGrid({
  rules,
  expireDays,
  ruleErrors,
  expireError,
  onFieldChange,
  onUnlockOnChange,
  onExpireDaysChange,
}: {
  rules: ReferralRules
  expireDays: number
  ruleErrors: ReferralRulesErrors
  expireError: string | undefined
  onFieldChange: (key: NumericKey, raw: string) => void
  onUnlockOnChange: (v: string) => void
  onExpireDaysChange: (raw: string) => void
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
            {key === "abandonDays" && rules.abandonDays === 0 && !ruleErrors.abandonDays && (
              <span className="text-xs text-muted-foreground">0 = 关闭注册即弃判定</span>
            )}
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
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">奖励积分有效期（天）</span>
          <Input
            type="number"
            className="h-9 w-full"
            value={displayValue(expireDays)}
            onChange={(e) => onExpireDaysChange(e.target.value)}
            aria-invalid={!!expireError}
          />
          {expireError && <span className="text-xs text-destructive">{expireError}</span>}
        </div>
      </div>
      <Separator />
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>单用户累计奖励达封顶（capPerUser）后，该用户的邀请关系 reward_state 置为 capped，不再继续发放。</span>
        <span>
          注册即弃判定：绑定超过 N 天时，被邀请人须已产生<b>有效行为</b>（积分消费或任意一笔已支付订单，首付即算），
          否则按「注册即弃」冻结关系不发奖并留痕；付过钱或用过积分的用户不受影响。
        </span>
        <span>实名唯一校验：系统当前无实名体系，待实名体系接入后启用，暂不做假校验/假开关。</span>
      </div>
    </>
  )
}
