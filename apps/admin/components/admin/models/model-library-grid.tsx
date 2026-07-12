"use client"

import { Plus } from "lucide-react"
import { ModelCard } from "./model-card"
import type { ModelEntry } from "@/lib/model-config"

export function ModelLibraryGrid({
  models,
  chain,
  savedModelIds,
  testingIds,
  testTokens,
  testMaxOutput,
  busy,
  onTest,
  onToggleEnable,
  onSave,
  onDelete,
  onAddToChain,
  onAdd,
}: {
  models: ModelEntry[]
  chain: string[]
  // 已在服务端持久化的 model id 集合：不在其中即视为「新添加、未提交」，卡片默认展开编辑态。
  savedModelIds: Set<string>
  testingIds: Set<string>
  // 探针返回的瞬态 token 数（id → tokens），仅用于展示，不落库。
  testTokens: Record<string, number>
  // 探针返回的瞬态模型最大输出上限（id → maxOutput），仅用于展示，不落库。
  testMaxOutput: Record<string, number>
  busy: boolean
  onTest: (id: string) => void
  onToggleEnable: (id: string, v: boolean) => void
  onSave: (next: ModelEntry) => void
  onDelete: (id: string) => void
  onAddToChain: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {models.map((m) => (
        <ModelCard
          key={m.id}
          model={m}
          isNew={!savedModelIds.has(m.id)}
          inChain={chain.includes(m.id)}
          testing={testingIds.has(m.id)}
          tokens={testTokens[m.id]}
          maxOutput={testMaxOutput[m.id]}
          busy={busy}
          onTest={() => onTest(m.id)}
          onToggleEnable={(v) => onToggleEnable(m.id, v)}
          onSave={onSave}
          onDelete={() => onDelete(m.id)}
          onAddToChain={() => onAddToChain(m.id)}
        />
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
      >
        <span className="flex size-9 items-center justify-center rounded-lg border border-border">
          <Plus className="size-5" />
        </span>
        <span className="text-sm font-medium">添加模型</span>
        <span className="text-xs">选服务商 · 填模型名 · 调参</span>
      </button>
    </div>
  )
}
