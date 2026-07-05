"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Wallet,
  Users,
  UserCheck,
  Coins,
  FolderKanban,
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
          title="今日营收"
          value={loading ? "—" : `¥${((data?.todayRevenueCents ?? 0) / 100).toLocaleString()}`}
          icon={Wallet}
          emphasize
        />
        <KpiCard
          title="总用户"
          value={fmt(data?.totalUsers)}
          icon={Users}
        />
        <KpiCard
          title="付费用户"
          value={fmt(data?.payingUsers)}
          icon={UserCheck}
        />
        <KpiCard
          title="今日积分流水"
          value={fmt(data?.creditTxSumToday)}
          icon={Coins}
        />
        <KpiCard
          title="活跃项目"
          value={fmt(data?.activeProjects)}
          icon={FolderKanban}
        />
      </div>

      <TrendCharts />
    </div>
  )
}
