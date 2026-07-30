"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Wallet,
  Users,
  UserCheck,
  Coins,
} from "lucide-react"

import { KpiCard } from "@/components/admin/kpi-card"
import { TrendCharts } from "@/components/admin/overview/trend-charts"
import { adminApi, type ApiOverview } from "@/lib/admin-api"

export default function OverviewPage() {
  const [data, setData] = useState<ApiOverview | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await adminApi.overview.get()
        if (alive) setData(res)
      } catch {
        if (alive) toast.error("加载概览数据失败")
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  const fmt = (n: number | undefined) =>
    loading || n === undefined ? "—" : n.toLocaleString()

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          title="总营收"
          value={loading ? "—" : `¥${((data?.totalRevenueCents ?? 0) / 100).toLocaleString()}`}
          icon={Wallet}
          hint="已支付订单额扣除已完成退款"
          emphasize
        />
        <KpiCard
          title="今日营收"
          value={loading ? "—" : `¥${((data?.todayRevenueCents ?? 0) / 100).toLocaleString()}`}
          icon={Wallet}
          hint="同样已扣除今日退款"
        />
        <KpiCard title="总用户" value={fmt(data?.totalUsers)} icon={Users} />
        <KpiCard title="付费用户" value={fmt(data?.payingUsers)} icon={UserCheck} hint="当前有效订阅用户数" />
        <KpiCard
          title="今日积分流水"
          value={fmt(data?.creditTxSumToday)}
          icon={Coins}
          hint={loading ? undefined : `${data?.creditTxCount ?? 0} 笔的净额`}
        />
      </div>

      <TrendCharts />
    </div>
  )
}
