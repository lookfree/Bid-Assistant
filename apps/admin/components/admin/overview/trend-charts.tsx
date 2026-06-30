"use client"

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
import { trendData } from "@/lib/mock-data"

const revenueConfig = {
  revenue: { label: "营收(元)", color: "var(--chart-1)" },
} satisfies ChartConfig

const activeConfig = {
  active: { label: "活跃用户", color: "var(--chart-3)" },
} satisfies ChartConfig

export function TrendCharts() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">营收趋势</CardTitle>
          <CardDescription>近 30 天每日营收（元）</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={revenueConfig} className="h-[240px] w-full">
            <AreaChart data={trendData} margin={{ left: 4, right: 8, top: 8 }}>
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
          <CardTitle className="text-base">活跃用户趋势</CardTitle>
          <CardDescription>近 30 天每日活跃用户</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={activeConfig} className="h-[240px] w-full">
            <AreaChart data={trendData} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillActive" x1="0" y1="0" x2="0" y2="1">
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
                dataKey="active"
                type="monotone"
                stroke="var(--chart-3)"
                strokeWidth={2}
                fill="url(#fillActive)"
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  )
}
