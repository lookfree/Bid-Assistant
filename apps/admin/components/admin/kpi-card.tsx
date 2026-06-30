import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

interface KpiCardProps {
  title: string
  value: string
  icon: LucideIcon
  deltaPct?: number
  hint?: string
  emphasize?: boolean
}

export function KpiCard({
  title,
  value,
  icon: Icon,
  deltaPct,
  hint,
  emphasize,
}: KpiCardProps) {
  const up = (deltaPct ?? 0) >= 0
  return (
    <Card className={cn(emphasize && "border-primary/40 bg-primary/5")}>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-lg",
              emphasize
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            )}
          >
            <Icon className="size-4" />
          </span>
        </div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {deltaPct !== undefined ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-medium",
                up ? "text-emerald-600" : "text-destructive"
              )}
            >
              {up ? (
                <ArrowUpRight className="size-3.5" />
              ) : (
                <ArrowDownRight className="size-3.5" />
              )}
              {Math.abs(deltaPct)}%
            </span>
          ) : null}
          <span className="text-muted-foreground">{hint ?? "较昨日"}</span>
        </div>
      </CardContent>
    </Card>
  )
}
