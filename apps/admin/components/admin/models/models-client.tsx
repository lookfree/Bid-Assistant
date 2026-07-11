"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { adminApi, AdminApiError } from "@/lib/admin-api"
import {
  DEFAULT_MODEL_PARAMS,
  canAddToChain,
  isInChain,
  moveInChain,
  persistedChainFor,
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
  // 探针返回的 token 数：只用于展示「✓ 128ms · N tokens」，不落库、不参与 PUT，刷新即丢弃。
  const [testTokens, setTestTokens] = useState<Record<string, number>>({})

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

  // 即时动作（启用/停用/删除）：乐观更新 + 立即整份 PUT。关键——payload 用「已保存链」，绝不裹挟
  // 用户尚未点「保存运行配置」确认的链编辑；本地 cfg 只改 models，保留 pending 的 cfg.chain（未保存徽标
  // 与 dirty 判断依赖它）。失败回滚 cfg + savedCfg。
  async function persistInstant(payload: ModelConfig, nextLocal: ModelConfig, successMessage?: string) {
    const prevCfg = cfg
    const prevSaved = savedCfg
    setCfg(nextLocal)
    setSavedCfg(payload)
    try {
      await adminApi.models.save(payload)
      if (successMessage) toast.success(successMessage)
    } catch (e) {
      setCfg(prevCfg)
      setSavedCfg(prevSaved)
      toast.error(e instanceof AdminApiError ? saveErrorMessage(e.code) : "保存失败，请重试")
    }
  }

  // 显式保存（保存参数 / 保存运行配置）：失败时保留用户的本地改动，方便直接重试。
  async function persistExplicit(payload: ModelConfig, nextLocal: ModelConfig, successMessage: string) {
    setSaving(true)
    try {
      await adminApi.models.save(payload)
      setCfg(nextLocal)
      setSavedCfg(payload)
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
    const { test, tokens } = await probeModel(model)
    setCfg((c) => (c ? { ...c, models: c.models.map((m) => (m.id === id ? { ...m, test } : m)) } : c))
    setTestTokens((prev) => {
      const next = { ...prev }
      if (test.status === "passed" && tokens !== undefined) next[id] = tokens
      else delete next[id]
      return next
    })
    setTestingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function handleToggleEnable(id: string, v: boolean) {
    if (!cfg || !savedCfg) return
    // 停用一个仍在运行编排中的模型：客户端先拦（准确文案），不要靠后端 400 回滚——那会误报
    // 「未测试通过」，而它其实是已测通、只是被停用。
    if (!v && isInChain(cfg.chain, id)) {
      toast.error("该模型在运行编排中使用，请先从降级链移除再停用")
      return
    }
    const models = cfg.models.map((m) => (m.id === id ? { ...m, enabled: v } : m))
    void persistInstant(
      { models, chain: persistedChainFor(savedCfg.chain, models) },
      { models, chain: cfg.chain },
      v ? "模型已启用" : "模型已停用",
    )
  }

  function handleDelete(id: string) {
    if (!cfg || !savedCfg) return
    const models = cfg.models.filter((m) => m.id !== id)
    void persistInstant(
      { models, chain: persistedChainFor(savedCfg.chain, models, id) },
      { models, chain: cfg.chain.filter((cid) => cid !== id) },
      "已删除模型",
    )
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
    if (!cfg || !savedCfg) return
    const models = cfg.models.map((m) => (m.id === next.id ? next : m))
    // 存参数是即时动作，同样只提交 models，链用已保存链（不裹挟未确认的链编辑）。
    void persistExplicit(
      { models, chain: persistedChainFor(savedCfg.chain, models) },
      { models, chain: cfg.chain },
      "模型参数已保存",
    )
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
    // 唯一持久化链变更的入口：整份提交 cfg（含 pending 链）。
    void persistExplicit(cfg, cfg, "运行编排已保存并生效")
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
          testTokens={testTokens}
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

// 连通性探测：/models/test 认 snake_case 参数（adminApi.models.test 内部已转换）。
// 自建条目（带 baseUrl）把 baseUrl/apiKey 一并透传，agent 侧才能直连该端点而非查注册表。
// 返回持久化用的 ModelTest（不含 tokens）+ 展示用的 tokens（瞬态，不落库）。
async function probeModel(model: ModelEntry): Promise<{ test: ModelTest; tokens?: number }> {
  try {
    const res = await adminApi.models.test({
      provider: model.provider,
      model: model.model,
      params: model.params,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
    })
    return res.ok
      ? { test: { status: "passed", at: new Date().toISOString(), latencyMs: res.latencyMs }, tokens: res.tokens }
      : { test: { status: "failed", error: res.error ?? "测试失败" } }
  } catch {
    return { test: { status: "failed", error: "请求失败，请重试" } }
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
