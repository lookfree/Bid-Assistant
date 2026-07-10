"use client"

import { ArrowUp, ArrowDown, X, Save, Radio } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  chainSummary,
  PROVIDER_LABELS,
  type ModelConfig,
  type ModelEntry,
} from "@/lib/model-config"

export function RunChainCard({
  cfg,
  dirty,
  saving,
  onMove,
  onRemove,
  onSave,
}: {
  cfg: ModelConfig
  dirty: boolean
  saving: boolean
  onMove: (id: string, dir: "up" | "down") => void
  onRemove: (id: string) => void
  onSave: () => void
}) {
  const byId = (id: string) => cfg.models.find((m) => m.id === id)

  return (
    <Card className="gap-4 py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Radio className="size-3.5 text-emerald-600" />
            <span>{chainSummary(cfg)}</span>
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <Badge variant="secondary" className="font-normal">
                有未保存的更改
              </Badge>
            )}
            <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
              <Save data-icon="inline-start" />
              保存运行配置
            </Button>
          </div>
        </div>

        {cfg.chain.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            尚未编排任何模型 — 请在下方模型库里把「已测通」的模型加入运行编排
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {cfg.chain.map((id, i) => {
              const m = byId(id)
              if (!m) return null
              return (
                <ChainSlot
                  key={id}
                  model={m}
                  rank={i + 1}
                  isPrimary={i === 0}
                  canUp={i > 0}
                  canDown={i < cfg.chain.length - 1}
                  onMove={(dir) => onMove(id, dir)}
                  onRemove={() => onRemove(id)}
                />
              )
            })}
            <p className="pt-1 text-center text-xs text-muted-foreground">
              ＋ 从下方模型库把「已测通」的模型加入降级链
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// 单个编排槽位：主模型高亮 + 序号，降级项按顺序编号；上下箭头调序、移除按钮。
function ChainSlot({
  model,
  rank,
  isPrimary,
  canUp,
  canDown,
  onMove,
  onRemove,
}: {
  model: ModelEntry
  rank: number
  isPrimary: boolean
  canUp: boolean
  canDown: boolean
  onMove: (dir: "up" | "down") => void
  onRemove: () => void
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
        isPrimary ? "border-primary/30 bg-primary/5" : "border-border bg-muted/30"
      }`}
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
          isPrimary ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground ring-1 ring-border"
        }`}
      >
        {isPrimary ? "主" : rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {PROVIDER_LABELS[model.provider]} · {model.model}
          {isPrimary && (
            <Badge className="h-4 px-1.5 text-[10px]" variant="default">
              主模型
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          temp {model.params.temperature} · max_tokens {model.params.maxTokens}
          {model.test.status === "passed" && model.test.latencyMs !== undefined ? ` · 测试通过 ${model.test.latencyMs}ms` : ""}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <Button size="icon-xs" variant="outline" disabled={!canUp} onClick={() => onMove("up")}>
          <ArrowUp />
        </Button>
        <Button size="icon-xs" variant="outline" disabled={!canDown} onClick={() => onMove("down")}>
          <ArrowDown />
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onRemove}>
        <X data-icon="inline-start" />
        移除
      </Button>
    </div>
  )
}
