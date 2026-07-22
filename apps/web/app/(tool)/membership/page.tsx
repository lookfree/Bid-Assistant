"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { copyText } from "@/lib/clipboard"
import Link from "next/link"
import { memberTiers, type TierId } from "@/lib/plans"
import { fetchMembership, fetchOrders, startRecharge, renewMembership } from "@/lib/membership-api"
import { api } from "@/lib/api"
import type { MembershipOverview, OrderView, LaunchResponse, Payway } from "@/lib/membership-types"
import { formatPeriodEnd, statusLabel, tierCardState, planPriceYuan, plansByTier } from "@/lib/membership-view"
import { peekMembershipCache, primeMembershipCache } from "@/lib/use-membership"
import { Check, X, Coins, Receipt, ArrowRight, Sparkles, Info, Infinity as InfinityIcon, TrendingUp, Copy } from "lucide-react"

const ORDER_STATUS: Record<OrderView["status"], { label: string; tone: string }> = {
  paid: { label: "已支付", tone: "bg-success/10 text-success" },
  created: { label: "待支付", tone: "bg-muted text-muted-foreground" },
  unknown: { label: "处理中", tone: "bg-muted text-muted-foreground" },
  failed: { label: "已失败", tone: "bg-destructive/10 text-destructive" },
  refunded: { label: "已退款", tone: "bg-muted text-muted-foreground" },
}
const ORDER_TYPE: Record<OrderView["type"], string> = { recharge: "积分充值", renewal: "会员续费", purchase: "购买" }

type PendingPay = { kind: "recharge" | "renew"; id: string; label: string }

export default function MembershipPage() {
  // 秒开：先用跨页共享缓存立即渲染余额/套餐（工具页大多已拉过）,load() 后台刷新校准;
  // 无缓存（直链进入）才走整页加载态。
  const [overview, setOverview] = useState<MembershipOverview | null>(() => peekMembershipCache())
  const [orders, setOrders] = useState<OrderView[]>([])
  const [loading, setLoading] = useState(() => peekMembershipCache() === null)
  const [error, setError] = useState<string | null>(null)
  const [billing, setBilling] = useState<"month" | "year">("month")
  const [pending, setPending] = useState<PendingPay | null>(null)
  const [qr, setQr] = useState<LaunchResponse | null>(null)
  const [paying, setPaying] = useState(false)

  const load = useCallback(async () => {
    // 已有可展示数据（缓存/上次加载）时后台静默刷新,不再整页转加载态（关扫码弹层后的刷新同理）
    if (peekMembershipCache() === null) setLoading(true)
    setError(null)
    try {
      const ov = await fetchMembership() // 会员总览是页面主体，失败才整页报错
      setOverview(ov)
      primeMembershipCache(ov) // 回写共享缓存:侧边栏积分卡/其它页下次秒开拿到最新值
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
    // 订单是次要区块：单独加载，失败只让订单区降级，不阻塞会员/余额/套餐
    try {
      const od = await fetchOrders(1, 20)
      setOrders(od.items)
    } catch {
      setOrders([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const currentTierId: TierId = overview?.subscription.tierId ?? "free"
  const credits = overview?.balance ?? 0
  const backendPlans = plansByTier(overview)
  const packs = overview?.rechargePacks ?? [] // 充值包由后端配置驱动，前端按真实 id 下单
  const currentTier = memberTiers.find((t) => t.id === currentTierId) ?? memberTiers[0]!
  const sub = overview?.subscription
  const currentIndex = memberTiers.findIndex((t) => t.id === currentTierId)

  async function pay(payway: Payway) {
    if (!pending) return
    setPaying(true)
    try {
      const resp =
        pending.kind === "recharge" ? await startRecharge(pending.id, payway) : await renewMembership(pending.id, payway)
      setQr(resp)
    } catch (e) {
      setError(e instanceof Error ? e.message : "下单失败")
      setPending(null)
    } finally {
      setPaying(false)
    }
  }

  function closePay() {
    setPending(null)
    setQr(null)
    void load() // 关闭扫码弹层后刷新余额/订阅/订单（后台轮询 markPaid 已入账）
  }

  if (loading) {
    return <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center text-sm text-muted-foreground">加载中…</div>
  }
  if (error && !overview) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center">
        <p className="text-sm text-destructive">加载失败：{error}</p>
        <button onClick={() => void load()} className="mt-3 rounded-lg border border-border px-4 py-2 text-sm">
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 sm:py-10">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">会员中心</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          按篇幅、字数与功能分档消耗积分，积分用尽可升级会员或单独充值
        </p>
      </div>

      {/* 积分余额 + 订阅状态 banner */}
      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="gradient-brand px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-white">
              <currentTier.icon className="size-5" />
              <span className="text-sm font-semibold">当前套餐：{currentTier.name}</span>
            </div>
            <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-medium text-white">
              {statusLabel(sub?.status ?? "none")}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-10 items-center justify-center rounded-xl bg-[oklch(0.96_0.06_85)] text-[oklch(0.55_0.13_75)]">
              <Coins className="size-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">剩余积分</p>
              <p className="mt-0.5 text-xl font-bold text-foreground">{credits.toLocaleString()}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{currentTierId === "free" ? "注册赠送额度" : "每月额度"}</p>
            <p className="mt-0.5 text-lg font-semibold text-foreground">
              {currentTier.credits.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">积分</span>
            </p>
          </div>
          {sub && sub.status !== "none" && sub.currentPeriodEnd && (
            <div>
              <p className="text-xs text-muted-foreground">到期时间</p>
              <p className="mt-0.5 text-lg font-semibold text-foreground">{formatPeriodEnd(sub.currentPeriodEnd)}</p>
            </div>
          )}
          <p className="flex-1 text-sm text-muted-foreground">
            {credits < 100
              ? "积分即将用尽，升级会员可获得更高每月额度，或单独充值积分继续使用。"
              : "消耗按功能分档计费，详见下方积分消耗说明。"}
          </p>
        </div>
      </section>

      {/* 会员套餐（后端价格 + 静态文案；重点突出推荐档与下一档） */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">会员套餐</h2>
            <p className="mt-1 text-xs text-muted-foreground">高频投标更划算 · 会员每积分单价低于单独充值</p>
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
            {(["month", "year"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBilling(b)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  billing === b ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                {b === "month" ? "月付" : "年付 · 更省"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {memberTiers.map((tier) => {
            const Icon = tier.icon
            const { isCurrent, isOwned, isNext } = tierCardState(tier.id, currentTierId)
            const isRecommended = !!tier.recommended
            const backend = backendPlans.get(tier.id)
            const price = planPriceYuan(backend, billing, billing === "year" ? tier.priceYear : tier.priceMonth)
            const unit = tier.id === "free" ? "" : billing === "year" ? "/ 年" : "/ 月"
            // 按当前月/年切换取对应 plan 行 id，避免年付误按月价成单（缺该周期套餐则不可下单）
            const planIdForCycle = backend ? (billing === "year" ? backend.planIdYear : backend.planIdMonth) : null
            const emphasis = isRecommended
              ? "border-primary ring-2 ring-primary shadow-lg sm:scale-[1.02]"
              : isNext
                ? "border-primary ring-1 ring-primary/40"
                : "border-border"
            const dimmed = !isRecommended && !isNext && !isCurrent
            const canBuy = tier.id !== "free" && !isCurrent && !isOwned && !!planIdForCycle

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col rounded-2xl border bg-card p-5 transition-all ${emphasis} ${
                  dimmed ? "opacity-90" : ""
                }`}
              >
                {(isRecommended || isNext) && (
                  <span
                    className={`absolute -top-2.5 left-5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      isRecommended ? "gradient-brand text-white" : "bg-[oklch(0.95_0.04_250)] text-primary"
                    }`}
                  >
                    {isRecommended ? (tier.badge ?? "推荐") : "建议升级"}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <div
                    className={`flex size-9 items-center justify-center rounded-lg ${
                      isRecommended ? "gradient-brand text-white" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{tier.name}</p>
                    {isCurrent && <p className="text-xs text-primary">当前方案</p>}
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{tier.tagline}</p>
                <div className="mt-3 flex items-end gap-1">
                  <span className="text-2xl font-bold text-foreground">¥{price}</span>
                  {unit && <span className="mb-1 text-xs text-muted-foreground">{unit}</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tier.id === "free"
                    ? "手机号注册即可使用"
                    : billing === "year"
                      ? `年付立省 ${tier.yearSave} 元 · 含每月 ${tier.credits.toLocaleString()} 积分`
                      : `含每月 ${tier.credits.toLocaleString()} 积分`}
                </p>
                <button
                  type="button"
                  disabled={!canBuy}
                  onClick={() =>
                    planIdForCycle &&
                    setPending({ kind: "renew", id: planIdForCycle, label: `${tier.name} · ${billing === "year" ? "年付" : "月付"}` })
                  }
                  className={`mt-4 w-full rounded-xl py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60 ${
                    isCurrent || isOwned
                      ? "border border-border bg-muted text-muted-foreground"
                      : isRecommended
                        ? "gradient-brand text-white"
                        : "border border-primary bg-card text-primary hover:bg-primary/5"
                  }`}
                >
                  {isCurrent ? "当前方案" : isOwned ? "已拥有" : tier.id === "free" ? "免费开始" : `开通${tier.name}`}
                </button>
                <ul className="mt-4 grid gap-2 border-t border-border pt-4">
                  {tier.features.map((f) => (
                    <li key={f.text} className="flex items-start gap-2 text-xs">
                      {f.included ? (
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[oklch(0.62_0.15_162)]" />
                      ) : (
                        <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
                      )}
                      <span className={f.included ? "text-foreground" : "text-muted-foreground/60"}>{f.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {currentIndex >= memberTiers.length - 1 && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="size-3.5 text-primary" />
            你已是最高档位会员，享有全部权益。
          </p>
        )}
      </section>

      {/* 单独充值积分 */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Coins className="size-5 text-[oklch(0.55_0.13_75)]" />
              单独充值积分
            </h2>
            <p className="mt-1 inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-[oklch(0.5_0.13_162)]">
                <InfinityIcon className="size-3.5" />
                积分长期有效 · 永不过期
              </span>
              <span>投标用多少买多少，按需充值无压力</span>
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-[oklch(0.96_0.04_250)] px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="size-3.5" />
            买得越多 · 每积分越便宜
          </span>
        </div>
        {packs.length > 0 ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {packs.map((pack) => (
              <div key={pack.id} className="relative flex flex-col rounded-2xl border border-border bg-card p-4">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-foreground">{pack.credits.toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">积分</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  ¥{((pack.amountYuan / pack.credits) * 100).toFixed(1)} / 100 积分
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-lg font-semibold text-foreground">¥{pack.amountYuan}</span>
                  <button
                    onClick={() => setPending({ kind: "recharge", id: pack.id, label: `${pack.credits.toLocaleString()} 积分` })}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    立即充值
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-5 rounded-2xl border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
            暂无可用充值包
          </p>
        )}
      </section>

      {/* 积分消耗说明 */}
      <section className="mt-10 rounded-2xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Info className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">积分消耗说明</h2>
          <span className="text-xs text-muted-foreground">按篇幅 · 字数 · 功能分档计费</span>
        </div>
        <ul className="divide-y divide-border">
          {(overview?.creditCosts ?? []).map((c) => (
            <li key={c.feature} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{c.feature}</p>
                <p className="text-xs text-muted-foreground">{c.desc}</p>
              </div>
              <span className="shrink-0 rounded-lg bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">
                {c.cost}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* 订单记录 + 帮助 */}
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-2xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-5 py-4">
            <Receipt className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">订单记录</h2>
          </div>
          {orders.length > 0 ? (
            <ul className="divide-y divide-border">
              {orders.map((o) => {
                const st = ORDER_STATUS[o.status]
                return (
                  <li key={o.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{ORDER_TYPE[o.type]}</p>
                      <p className="text-xs text-muted-foreground">
                        订单号 {o.id.slice(0, 12)} · {formatPeriodEnd(o.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm font-semibold text-foreground">¥{o.amountYuan}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.tone}`}>{st.label}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">暂无订单记录</p>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <ReferralCard />
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">对套餐有疑问？</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              我们的顾问可帮你根据投标频率挑选最划算的方案。
            </p>
            <Link href="/feedback" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              联系客服
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <div className="rounded-2xl gradient-brand-soft border border-primary/15 p-5">
            <p className="text-sm font-semibold text-foreground">开发票</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              已支付订单均可申请电子发票，开票后发送至你的邮箱。
            </p>
            <button className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              申请开票
              <ArrowRight className="size-4" />
            </button>
          </div>
        </aside>
      </div>

      {pending && <PayModal pending={pending} qr={qr} paying={paying} onPay={pay} onClose={closePay} />}
    </div>
  )
}

/** 扫码支付弹层：先选钱包 → 下单拿 qrCode → 展示二维码/链接供扫码。 */
function PayModal(props: {
  pending: PendingPay
  qr: LaunchResponse | null
  paying: boolean
  onPay: (payway: Payway) => void
  onClose: () => void
}) {
  const { pending, qr, paying, onPay, onClose } = props
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-semibold text-foreground">
          {pending.kind === "recharge" ? "充值" : "开通"} · {pending.label}
        </p>
        {!qr ? (
          <div className="mt-5">
            <p className="text-xs text-muted-foreground">选择支付方式（扫码支付）</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button
                disabled={paying}
                onClick={() => onPay("alipay")}
                className="rounded-xl border border-primary py-2.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-60"
              >
                支付宝
              </button>
              <button
                disabled={paying}
                onClick={() => onPay("wechat")}
                className="rounded-xl border border-[oklch(0.62_0.15_162)] py-2.5 text-sm font-medium text-[oklch(0.5_0.13_162)] hover:bg-[oklch(0.62_0.15_162)]/5 disabled:opacity-60"
              >
                微信
              </button>
            </div>
            {paying && <p className="mt-3 text-center text-xs text-muted-foreground">下单中…</p>}
          </div>
        ) : (
          <div className="mt-5 text-center">
            {qr.qrImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.qrImageUrl} alt="支付二维码" className="mx-auto size-48 rounded-lg border border-border" />
            ) : (
              <p className="break-all rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{qr.qrCode}</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">请使用对应 App 扫码完成支付，支付后本页将自动刷新。</p>
          </div>
        )}
        <button onClick={onClose} className="mt-5 w-full rounded-xl border border-border py-2 text-sm text-muted-foreground">
          {qr ? "我已支付 / 关闭" : "取消"}
        </button>
      </div>
    </div>
  )
}

/** 邀请入口（spec307）：展示我的邀请码 + 邀请数 + 一键复制邀请链接；绑定在注册流程完成，此处不做绑定写。 */
function ReferralCard() {
  const [code, setCode] = useState<string | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function copyLink() {
    if (!code) return
    const ok = await copyText(`${window.location.origin}/login?ref=${code}`)
    setCopyState(ok ? "copied" : "failed") // 失败也要反馈，静默失败会让用户拿旧剪贴板去分享
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2000)
  }
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const c = await api.request<{ code: string }>("/api/referral/code")
        const l = await api.request<{ list: unknown[] }>("/api/referral/list")
        if (!alive) return
        setCode(c.code)
        setCount(l.list.length)
      } catch {
        if (alive) setLoadFailed(true) // 不阻塞会员中心主体，但不能永远停在"加载中"
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-sm font-semibold text-foreground">邀请好友</p>
      {code ? (
        <>
          <p className="mt-1.5 text-xs text-muted-foreground">我的邀请码</p>
          <p className="mt-1 font-mono text-lg font-bold tracking-widest text-primary">{code}</p>
          <p className="mt-2 text-xs text-muted-foreground">已邀请 {count ?? 0} 人</p>
          <button
            type="button"
            onClick={copyLink}
            className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {copyState === "copied" ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            {copyState === "copied" ? "已复制，快去分享吧" : copyState === "failed" ? "复制失败，请手动复制" : "复制邀请链接"}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">好友通过链接注册，双方都得积分奖励</p>
        </>
      ) : loadFailed ? (
        <p className="mt-1.5 text-xs text-muted-foreground">邀请信息加载失败，刷新页面重试</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">加载中…</p>
      )}
    </div>
  )
}
