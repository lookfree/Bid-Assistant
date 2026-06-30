import {
  Wallet,
  Users,
  Repeat,
  Coins,
  RotateCcw,
} from "lucide-react"

import { KpiCard } from "@/components/admin/kpi-card"
import { TrendCharts } from "@/components/admin/overview/trend-charts"
import { kpis } from "@/lib/mock-data"

export default function OverviewPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          title="今日营收"
          value={`¥${kpis.revenueToday.toLocaleString()}`}
          icon={Wallet}
          deltaPct={kpis.revenueDeltaPct}
          emphasize
        />
        <KpiCard
          title="活跃用户"
          value={kpis.activeUsers.toLocaleString()}
          icon={Users}
          deltaPct={kpis.activeDeltaPct}
        />
        <KpiCard
          title="新增 / 续费订阅"
          value={`${kpis.newSubs} / ${kpis.renewSubs}`}
          icon={Repeat}
          hint="今日新增 / 续费"
        />
        <KpiCard
          title="今日积分消耗"
          value={kpis.pointsConsumedToday.toLocaleString()}
          icon={Coins}
          deltaPct={kpis.pointsDeltaPct}
        />
        <KpiCard
          title="待退款数"
          value={`${kpis.pendingRefunds}`}
          icon={RotateCcw}
          hint="待财务处理"
        />
      </div>

      <TrendCharts />
    </div>
  )
}
