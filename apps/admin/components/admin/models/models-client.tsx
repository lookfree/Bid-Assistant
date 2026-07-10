"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import {
  DEFAULT_MODEL_PARAMS,
  canAddToChain,
  moveInChain,
  saveErrorMessage,
  type ModelConfig,
  type ModelEntry,
  type ModelTest,
} from "@/lib/model-config"
import { RunChainCard } from "./run-chain-card"
import { ModelLibraryGrid } from "./model-library-grid"

// 模型管理页（spec319 Task C）：运行编排（主模型+降级链）+ 模型库（配置/调参/测试/启用）。
// 持久化策略：启用开关/删除/测试是原子操作，改一次立即整份 PUT（与用户管理 ban/unban 同惯例）；
// 编辑参数与运行编排的改动（加入/调序/移出）先只改本地 state，分别通过各自的「保存」按钮显式提交，
// 因为它们涉及多字段/多槽位的批量变更，需要用户确认后再一次性生效。
export function ModelsClient() {
  const [cfg, setCfg] = useState<ModelConfig | null>(null)
  const [savedCfg, setSavedCfg] = useState<ModelConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    adminApi.models
      .get()
      .then((c) => {
        if (!alive) return
        setCfg(c)
        setSavedCfg(c)
      })
      .catch(() => alive && toast.error("加载模型配置失败"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // 原子操作（启用/删除）：乐观更新 + 立即整份 PUT；失败回滚到操作前的本地状态（不影响其它未保存的编辑）。
  async function persistInstant(next: ModelConfig, successMessage?: string) {
    const prev = cfg
    setCfg(next)
    try {
      await adminApi.models.save(next)
      setSavedCfg(next)
      if (successMessage) toast.success(successMessage)
    } catch (e) {
      setCfg(prev)
      toast.error(e instanceof AdminApiError ? saveErrorMessage(e.code) : "保存失败，请重试")
    }
  }

  // 显式保存（保存参数 / 保存运行配置）：失败时保留用户的本地改动，方便直接重试。
  async function persistExplicit(next: ModelConfig, successMessage: string) {
    setSaving(true)
    try {
      await adminApi.models.save(next)
      setCfg(next)
      setSavedCfg(next)
      toast.success(successMessage)
    } catch (e) {
      toast.error(e instanceof AdminApiError ? saveErrorMessage(e.code) : "保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(id: string) {
    if (!cfg) return
    const model = cfg.models.find((m) => m.id === id)
    if (!model) return
    setTestingIds((prev) => new Set(prev).add(id))
    const test = await probeModel(model)
    setCfg((c) => (c ? { ...c, models: c.models.map((m) => (m.id === id ? { ...m, test } : m)) } : c))
    setTestingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function handleToggleEnable(id: string, v: boolean) {
    if (!cfg) return
    const next = { ...cfg, models: cfg.models.map((m) => (m.id === id ? { ...m, enabled: v } : m)) }
    void persistInstant(next, v ? "模型已启用" : "模型已停用")
  }

  function handleDelete(id: string) {
    if (!cfg) return
    const next = { models: cfg.models.filter((m) => m.id !== id), chain: cfg.chain.filter((cid) => cid !== id) }
    void persistInstant(next, "已删除模型")
  }

  function handleAdd() {
    if (!cfg) return
    const draft: ModelEntry = {
      id: `m_${crypto.randomUUID()}`,
      provider: "deepseek",
      model: "",
      params: DEFAULT_MODEL_PARAMS,
      enabled: false,
      test: { status: "untested" },
    }
    setCfg({ ...cfg, models: [...cfg.models, draft] })
  }

  function handleSaveModel(next: ModelEntry) {
    if (!cfg) return
    void persistExplicit({ ...cfg, models: cfg.models.map((m) => (m.id === next.id ? next : m)) }, "模型参数已保存")
  }

  function handleAddToChain(id: string) {
    if (!cfg) return
    const model = cfg.models.find((m) => m.id === id)
    if (!model || cfg.chain.includes(id) || !canAddToChain(model)) return
    setCfg({ ...cfg, chain: [...cfg.chain, id] })
  }

  function handleChainMove(id: string, dir: "up" | "down") {
    if (!cfg) return
    setCfg({ ...cfg, chain: moveInChain(cfg.chain, id, dir) })
  }

  function handleChainRemove(id: string) {
    if (!cfg) return
    setCfg({ ...cfg, chain: cfg.chain.filter((cid) => cid !== id) })
  }

  function handleSaveChain() {
    if (!cfg) return
    const invalid = cfg.chain.some((id) => {
      const m = cfg.models.find((mm) => mm.id === id)
      return !m || !canAddToChain(m)
    })
    if (invalid) {
      toast.error(saveErrorMessage("chain_requires_tested_models"))
      return
    }
    void persistExplicit(cfg, "运行编排已保存并生效")
  }

  if (loading || !cfg) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader />
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    )
  }

  const chainDirty = savedCfg !== null && JSON.stringify(cfg.chain) !== JSON.stringify(savedCfg.chain)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader />

      <Section index={1} title="运行编排 · 主模型与降级链">
        <RunChainCard
          cfg={cfg}
          dirty={chainDirty}
          saving={saving}
          onMove={handleChainMove}
          onRemove={handleChainRemove}
          onSave={handleSaveChain}
        />
      </Section>

      <Section index={2} title="模型库 · 配置 · 调参 · 测试">
        <ModelLibraryGrid
          models={cfg.models}
          chain={cfg.chain}
          savedModelIds={new Set(savedCfg?.models.map((m) => m.id) ?? [])}
          testingIds={testingIds}
          busy={saving}
          onTest={handleTest}
          onToggleEnable={handleToggleEnable}
          onSave={handleSaveModel}
          onDelete={handleDelete}
          onAddToChain={handleAddToChain}
          onAdd={handleAdd}
        />
      </Section>
    </div>
  )
}

// 连通性探测：/models/test 认 snake_case 参数（adminApi.models.test 内部已转换），
// 成功/失败都落成本地 ModelTest，不落库——落库随下一次启用/删除/保存等动作一并整份提交。
async function probeModel(model: ModelEntry): Promise<ModelTest> {
  try {
    const res = await adminApi.models.test({ provider: model.provider, model: model.model, params: model.params })
    return res.ok
      ? { status: "passed", at: new Date().toISOString(), latencyMs: res.latencyMs }
      : { status: "failed", error: res.error ?? "测试失败" }
  } catch {
    return { status: "failed", error: "请求失败，请重试" }
  }
}

function PageHeader() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">模型管理</h2>
      <p className="text-sm text-muted-foreground text-pretty">
        配置投标智能体调用的大模型 — 先在模型库里配好并测通，再编排到主模型与降级链。改动保存后立即对新任务生效。
      </p>
    </div>
  )
}

function Section({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        <span className="flex size-5 items-center justify-center rounded-md bg-primary text-[11px] text-primary-foreground">
          {index}
        </span>
        {title}
      </div>
      {children}
    </div>
  )
}
