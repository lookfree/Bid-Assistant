"use client"

import { useState } from "react"
import Link from "next/link"
import { memberTiers, creditCosts, creditPacks, DEMO_CREDIT_BALANCE, type TierId } from "@/lib/plans"
import { Check, X, Coins, Receipt, ArrowRight, Sparkles, Info, Infinity as InfinityIcon, TrendingUp } from "lucide-react"

const orders = [
  { id: "NO20260612", name: "积分充值包 5000", amount: "¥139", date: "2026-06-12", status: "已支付" },
  { id: "NO20260520", name: "个人版 · 月付", amount: "¥39", date: "2026-05-20", status: "已支付" },
]

export default function MembershipPage() {
  // 演示：当前用户所在档位（免费版）与积分余额
  const [currentTierId, setCurrentTierId] = useState<TierId>("free")
  const [credits, setCredits] = useState(DEMO_CREDIT_BALANCE)
  const [billing, setBilling] = useState<"month" | "year">("month")

  const currentIndex = memberTiers.findIndex((t) => t.id === currentTierId)
  const currentTier = memberTiers[currentIndex]
  const monthlyQuota = currentTier.credits

  function upgradeTo(id: TierId) {
    const tier = memberTiers.find((t) => t.id === id)
    if (!tier) return
    setCurrentTierId(id)
    setCredits(tier.credits)
  }

  function buyPack(packCredits: number) {
    setCredits((c) => c + packCredits)
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 sm:py-10">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">会员中心</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          按篇幅、字数与功能分档消耗积分，积分用尽可升级会员或单独充值
        </p>
      </div>

      {/* 积分余额概览 banner */}
      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="gradient-brand px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-white">
              <currentTier.icon className="size-5" />
              <span className="text-sm font-semibold">当前套餐：{currentTier.name}</span>
            </div>
            <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-medium text-white">
              {currentTier.id === "free" ? "免费体验中" : "会员有效"}
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
            <p className="text-xs text-muted-foreground">{currentTier.id === "free" ? "注册赠送额度" : "每月额度"}</p>
            <p className="mt-0.5 text-lg font-semibold text-foreground">
              {monthlyQuota.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">积分</span>
            </p>
          </div>
          <p className="flex-1 text-sm text-muted-foreground">
            {credits < 100
              ? "积分即将用尽，升级会员可获得更高每月额度，或单独充值积分继续使用。"
              : "消耗按功能分档计费，详见下方积分消耗说明。"}
          </p>
        </div>
      </section>

      {/* 会员套餐（全部档位展示，重点突出推荐档与下一档） */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">会员套餐</h2>
            <p className="mt-1 text-xs text-muted-foreground">高频投标更划算 · 会员每积分单价低于单独充值</p>
          </div>
          {/* 月付 / 年付切换 */}
          <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
            <button
              onClick={() => setBilling("month")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                billing === "month" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              月付
            </button>
            <button
              onClick={() => setBilling("year")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                billing === "year" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              年付 · 更省
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {memberTiers.map((tier, idx) => {
            const Icon = tier.icon
            const isCurrent = tier.id === currentTierId
            const isOwned = idx < currentIndex
            const isNext = idx === currentIndex + 1
            const isRecommended = !!tier.recommended
            const price = billing === "year" ? tier.priceYear : tier.priceMonth
            const unit = tier.id === "free" ? "" : billing === "year" ? "/ 年" : "/ 月"

            // 视觉优先级：推荐档 > 下一档（建议升级）> 其余弱化
            const emphasis = isRecommended
              ? "border-primary ring-2 ring-primary shadow-lg sm:scale-[1.02]"
              : isNext
                ? "border-primary ring-1 ring-primary/40"
                : "border-border"
            const dimmed = !isRecommended && !isNext && !isCurrent

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
                  disabled={isCurrent || isOwned}
                  onClick={() => upgradeTo(tier.id)}
                  className={`mt-4 w-full rounded-xl py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60 ${
                    isCurrent || isOwned
                      ? "border border-border bg-muted text-muted-foreground"
                      : isRecommended
                        ? "gradient-brand text-white"
                        : "border border-primary bg-card text-primary hover:bg-primary/5"
                  }`}
                >
                  {isCurrent ? "当前方案" : isOwned ? "已拥有" : tier.id === "free" ? "免费开始" : `升级到${tier.name}`}
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

      {/* 单独充值积分（C 端主力，与会员套餐同等显眼） */}
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
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {creditPacks.map((pack) => (
            <div
              key={pack.id}
              className={`relative flex flex-col rounded-2xl border bg-card p-4 ${
                pack.popular ? "border-primary ring-1 ring-primary/40 shadow-sm" : "border-border"
              }`}
            >
              {pack.popular && (
                <span className="absolute -top-2.5 left-4 rounded-full bg-[oklch(0.95_0.04_250)] px-2.5 py-0.5 text-xs font-medium text-primary">
                  超值之选
                </span>
              )}
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-foreground">{pack.credits.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">积分</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{pack.unit}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-lg font-semibold text-foreground">¥{pack.price}</span>
                <button
                  onClick={() => buyPack(pack.credits)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    pack.popular
                      ? "gradient-brand text-white hover:opacity-90"
                      : "border border-border bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  立即充值
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 积分消耗说明 */}
      <section className="mt-10 rounded-2xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Info className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">积分消耗说明</h2>
          <span className="text-xs text-muted-foreground">按篇幅 · 字数 · 功能分档计费</span>
        </div>
        <ul className="divide-y divide-border">
          {creditCosts.map((c) => (
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
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{o.name}</p>
                    <p className="text-xs text-muted-foreground">
                      订单号 {o.id} · {o.date}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-semibold text-foreground">{o.amount}</span>
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                      {o.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">暂无订单记录</p>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">对套餐有疑问？</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              我们的顾问可帮你根据投标频率挑选最划算的方案。
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
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
    </div>
  )
}
