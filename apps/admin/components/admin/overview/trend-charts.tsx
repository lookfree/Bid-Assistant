"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { adminApi, type ApiTrendPoint } from "@/lib/admin-api"

const revenueConfig = {
  revenue: { label: "营收(元)", color: "var(--chart-1)" },
} satisfies ChartConfig

const creditsConfig = {
  credits: { label: "积分流水", color: "var(--chart-3)" },
} satisfies ChartConfig

export function TrendCharts() {
  const [data, setData] = useState<ApiTrendPoint[]>([])

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await adminApi.overview.trend(14)
        if (alive) setData(res)
      } catch {
        if (alive) toast.error("加载趋势数据失败")
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">营收趋势</CardTitle>
          <CardDescription>近 14 天每日营收（元）</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={revenueConfig} className="h-[240px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval={4}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                dataKey="revenue"
                type="monotone"
                stroke="var(--chart-1)"
                strokeWidth={2}
                fill="url(#fillRevenue)"
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">积分流水趋势</CardTitle>
          <CardDescription>近 14 天每日积分流水</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={creditsConfig} className="h-[240px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillCredits" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--chart-3)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--chart-3)" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval={4}
              />
              <YAxis tickLine={false} axisLine={false} width={44} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                dataKey="credits"
                type="monotone"
                stroke="var(--chart-3)"
                strokeWidth={2}
                fill="url(#fillCredits)"
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  )
}
