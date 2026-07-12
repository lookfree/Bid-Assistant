"use client"

import { useState } from "react"
import {
  CheckCircle2,
  XCircle,
  Loader2,
  PlugZap,
  Pencil,
  Save,
  X,
  Trash2,
  PlusCircle,
  Download,
} from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { adminApi } from "@/lib/admin-api"
import { ParamView, ParamEdit } from "./param-field"
import {
  PROVIDER_OPTIONS,
  providerLabel,
  modelDisplayName,
  canEnable,
  canAddToChain,
  resetTestOnEdit,
  isCustomEntry,
  providerDefaultBaseUrl,
  providerDefaultMaxTokens,
  type ModelEntry,
} from "@/lib/model-config"

const PROVIDER_LOGO: Record<string, { short: string; className: string }> = {
  deepseek: { short: "DS", className: "bg-primary text-primary-foreground" },
  qwen: { short: "通", className: "bg-amber-500 text-white" },
  glm: { short: "智", className: "bg-sky-500 text-white" },
  custom: { short: "自", className: "bg-neutral-600 text-white" },
}

type CardProps = {
  model: ModelEntry
  // 新添加、尚未提交过一次「保存参数」的卡片：默认展开编辑态，取消即整卡丢弃（而非还原）。
  isNew: boolean
  inChain: boolean
  testing: boolean
  // 本次会话内探针返回的 token 数（瞬态，不落库）；有值时测试行显示「· N tokens」。
  tokens?: number
  // 本次会话内探针返回的模型真实最大输出（瞬态，不落库）；有值时测试行追加「· 最大输出 N」，
  // 且当前 maxTokens 参数超过它时在参数区给出提醒。
  maxOutput?: number
  // 是否有其它整份 PUT 正在进行（保存参数/保存运行配置）：期间禁用会产生写冲突的操作，避免并发覆盖。
  busy: boolean
  onTest: () => void
  onToggleEnable: (v: boolean) => void
  onSave: (next: ModelEntry) => void
  onDelete: () => void
  onAddToChain: () => void
}

export function ModelCard({ model, isNew, inChain, testing, tokens, maxOutput, busy, onTest, onToggleEnable, onSave, onDelete, onAddToChain }: CardProps) {
  const [editing, setEditing] = useState(isNew)
  const [draft, setDraft] = useState<ModelEntry>(model)
  // 编辑态下对草稿本身的连通性测试（Task 3 的保存门槛）：draft 的每次字段编辑都已经过 resetTestOnEdit
  // 使 draft.test 归为 untested，所以这里测出的结果始终对应「当前草稿」，commit() 无需再自行判断是否变化。
  const draftTest = useDraftTest(draft, setDraft)

  function startEdit() {
    setDraft(model)
    setEditing(true)
  }

  function commit() {
    onSave(draft)
    setEditing(false)
  }

  function cancel() {
    if (isNew) {
      onDelete()
      return
    }
    setEditing(false)
  }

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex-row items-start justify-between gap-2 px-4">
        <ProviderIdentity model={model} editing={editing} draft={draft} setDraft={setDraft} />
        <TestStatusChip model={editing ? draft : model} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4">
        <ParamsGrid
          editing={editing}
          model={model}
          draft={draft}
          setDraft={setDraft}
          maxOutput={editing ? draftTest.maxOutput : maxOutput}
        />
        {editing && isCustomEntry(draft) && <CustomEndpointFields draft={draft} setDraft={setDraft} />}
        {editing && !isCustomEntry(draft) && <BuiltinEndpointFields draft={draft} setDraft={setDraft} />}
        <TestLine
          model={editing ? draft : model}
          inChain={inChain}
          tokens={editing ? draftTest.tokens : tokens}
          maxOutput={editing ? draftTest.maxOutput : maxOutput}
        />

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <CardActions
            editing={editing}
            busy={busy}
            testing={testing}
            draft={draft}
            draftTesting={draftTest.testing}
            model={model}
            onTest={onTest}
            onTestDraft={draftTest.run}
            onDelete={onDelete}
            startEdit={startEdit}
            commit={commit}
            cancel={cancel}
          />
          <EnableSwitch model={model} busy={busy} onToggleEnable={onToggleEnable} />
        </div>

        <AddToChainRow model={model} inChain={inChain} onAddToChain={onAddToChain} />
      </CardContent>
    </Card>
  )
}

// 编辑态草稿的连通性测试：直接调 adminApi（同 CustomEndpointFields/BuiltinModelFetch 已有的
// 「组件内直调 adminApi」惯例），结果只写回本地 draft.test，不经过父组件的 testingIds/onTest
// （那套只认已保存的 model，草稿字段父组件还看不到）。测试通过后「保存参数」才会解锁（见 CardActions）。
function useDraftTest(draft: ModelEntry, setDraft: (updater: (d: ModelEntry) => ModelEntry) => void) {
  const [testing, setTesting] = useState(false)
  const [tokens, setTokens] = useState<number | undefined>(undefined)
  const [maxOutput, setMaxOutput] = useState<number | undefined>(undefined)

  async function run() {
    setTesting(true)
    try {
      const res = await adminApi.models.test({
        provider: draft.provider,
        model: draft.model,
        params: draft.params,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        id: draft.id, // 已保存条目重测：apiKey 打码不回显，带 id 让服务端回填库里 key
      })
      if (res.ok) {
        setDraft((d) => ({ ...d, test: { status: "passed", at: new Date().toISOString(), latencyMs: res.latencyMs } }))
        setTokens(res.tokens)
        setMaxOutput(res.maxOutput)
      } else {
        setDraft((d) => ({ ...d, test: { status: "failed", error: res.error ?? "测试失败" } }))
        setTokens(undefined)
        setMaxOutput(undefined)
      }
    } catch {
      setDraft((d) => ({ ...d, test: { status: "failed", error: "请求失败，请重试" } }))
      setTokens(undefined)
      setMaxOutput(undefined)
    } finally {
      setTesting(false)
    }
  }
  return { testing, tokens, maxOutput, run }
}

// 卡片头：服务商 logo + 名称/模型名；编辑态下 provider 是 Select、model 名是 Input。
function ProviderIdentity({
  model,
  editing,
  draft,
  setDraft,
}: {
  model: ModelEntry
  editing: boolean
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
}) {
  const logo = PROVIDER_LOGO[model.provider] ?? PROVIDER_LOGO.deepseek
  const subtitle = !model.model ? "（未填模型名）" : model.baseUrl ? modelDisplayName(model) : model.model
  return (
    <div className="flex items-center gap-2.5">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${logo.className}`}>
        {logo.short}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          <Select value={draft.provider} onValueChange={(v) => v && setDraft((d) => switchProvider(d, v))}>
            <SelectTrigger className="h-7 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-7 w-36 text-xs"
            placeholder="模型名，如 deepseek-chat"
            value={draft.model}
            onChange={(e) => setDraft((d) => resetTestOnEdit({ ...d, model: e.target.value }))}
          />
        </div>
      ) : (
        <div>
          <div className="text-sm font-semibold text-foreground">{providerLabel(model.provider)}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
      )}
    </div>
  )
}

// provider 切到「custom」：清空 model（自建模型名与注册表不通用，避免带着旧值误导）；
// 切离 custom：清掉自建专属字段（baseUrl/apiKey/apiKeyHint），避免残留 baseUrl 让服务端仍判定为自建条目。
// 切换服务商统一重置 maxTokens 为该服务商默认值（同 model 一样重置，brief 指定）。
// 测试状态一律重置（resetTestOnEdit）——旧的测试结果是针对旧 provider/model 测的，切换后不再有效。
function switchProvider(d: ModelEntry, nextProvider: string): ModelEntry {
  if (nextProvider === d.provider) return d
  const params = { ...d.params, maxTokens: providerDefaultMaxTokens(nextProvider) }
  if (nextProvider === "custom") return resetTestOnEdit({ ...d, provider: nextProvider, model: "", params })
  return resetTestOnEdit({ ...d, provider: nextProvider, baseUrl: undefined, apiKey: undefined, apiKeyHint: undefined, params })
}

// 三个参数（temperature/max_tokens/top_p）：只读展示 or 编辑输入框，取决于 editing。
// maxOutput（探针探得的模型真实最大输出，瞬态）：当前 maxTokens 超过它时，在参数区下方给出提醒
// （只提醒，不自动改值——是否下调由管理员决定）。
function ParamsGrid({
  editing,
  model,
  draft,
  setDraft,
  maxOutput,
}: {
  editing: boolean
  model: ModelEntry
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
  maxOutput?: number
}) {
  const currentMaxTokens = editing ? draft.params.maxTokens : model.params.maxTokens
  const exceedsMaxOutput = maxOutput !== undefined && currentMaxTokens > maxOutput
  if (!editing)
    return (
      <div className="flex flex-col gap-1">
        <div className="grid grid-cols-3 gap-2">
          <ParamView paramKey="temperature" value={model.params.temperature} />
          <ParamView paramKey="maxTokens" value={model.params.maxTokens} />
          <ParamView paramKey="topP" value={model.params.topP} />
        </div>
        {exceedsMaxOutput && <MaxOutputWarning maxOutput={maxOutput!} />}
      </div>
    )
  const setParam = (key: keyof ModelEntry["params"]) => (v: number) =>
    setDraft((d) => resetTestOnEdit({ ...d, params: { ...d.params, [key]: v } }))
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-3 gap-2">
        <ParamEdit paramKey="temperature" value={draft.params.temperature} onChange={setParam("temperature")} />
        <ParamEdit paramKey="maxTokens" value={draft.params.maxTokens} onChange={setParam("maxTokens")} />
        <ParamEdit paramKey="topP" value={draft.params.topP} onChange={setParam("topP")} />
      </div>
      {exceedsMaxOutput && <MaxOutputWarning maxOutput={maxOutput!} />}
    </div>
  )
}

function MaxOutputWarning({ maxOutput }: { maxOutput: number }) {
  return <p className="text-xs text-amber-600">超过模型上限 {maxOutput}，建议下调</p>
}

// 卡片底部行动按钮：编辑态显示测试草稿/保存/取消，非编辑态显示测试/编辑参数/删除。
// Task 3 保存门槛：编辑态的「保存参数」在 draft.test.status !== "passed" 时禁用 + 提示，
// 逼着用户先点「测试连通」测过草稿本身才能保存（草稿测试见 useDraftTest）。
function CardActions({
  editing,
  busy,
  testing,
  draft,
  draftTesting,
  model,
  onTest,
  onTestDraft,
  onDelete,
  startEdit,
  commit,
  cancel,
}: {
  editing: boolean
  busy: boolean
  testing: boolean
  draft: ModelEntry
  draftTesting: boolean
  model: ModelEntry
  onTest: () => void
  onTestDraft: () => void
  onDelete: () => void
  startEdit: () => void
  commit: () => void
  cancel: () => void
}) {
  if (editing) {
    const canSave = draft.test.status === "passed"
    const saveButton = (
      <Button size="sm" onClick={commit} disabled={busy || !canSave}>
        <Save data-icon="inline-start" />
        保存参数
      </Button>
    )
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={onTestDraft} disabled={busy || draftTesting}>
          {draftTesting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <PlugZap data-icon="inline-start" />}
          {draft.test.status === "failed" ? "重新测试" : "测试连通"}
        </Button>
        {canSave ? (
          saveButton
        ) : (
          <Tooltip>
            <TooltipTrigger render={saveButton} />
            <TooltipContent side="top">请先测试连通再保存</TooltipContent>
          </Tooltip>
        )}
        <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
          <X data-icon="inline-start" />
          取消
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant={model.test.status === "passed" ? "outline" : "default"} onClick={onTest} disabled={testing || busy}>
        {testing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <PlugZap data-icon="inline-start" />}
        {model.test.status === "failed" ? "重新测试" : "测试连通"}
      </Button>
      <Button size="sm" variant="link" className="h-auto p-0" onClick={startEdit} disabled={busy}>
        <Pencil data-icon="inline-start" />
        编辑参数
      </Button>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onDelete} disabled={busy}>
        <Trash2 data-icon="inline-start" />
      </Button>
    </div>
  )
}

// 状态角标：测试通过/未测试/测试失败。
function TestStatusChip({ model }: { model: ModelEntry }) {
  if (model.test.status === "passed")
    return (
      <Badge variant="secondary" className="gap-1 bg-emerald-100 text-emerald-700">
        <CheckCircle2 />测试通过
      </Badge>
    )
  if (model.test.status === "failed")
    return (
      <Badge variant="secondary" className="gap-1 bg-destructive/10 text-destructive">
        <XCircle />测试失败
      </Badge>
    )
  return (
    <Badge variant="secondary" className="gap-1 bg-amber-100 text-amber-700">
      未测试
    </Badge>
  )
}

// 连通性测试结果行：成功显示延迟/token/时间，失败显示错误，未测显示引导语；
// 若参数已改（重置为 untested）且模型仍在编排链中，提示需要重测。tokens/maxOutput 为本会话瞬态值（可缺省）。
function TestLine({
  model,
  inChain,
  tokens,
  maxOutput,
}: {
  model: ModelEntry
  inChain: boolean
  tokens?: number
  maxOutput?: number
}) {
  if (model.test.status === "passed")
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-emerald-700">✓ 连通</span>
        <span className="tabular-nums">
          {model.test.latencyMs}ms
          {tokens !== undefined ? ` · ${tokens} tokens` : ""}
          {maxOutput !== undefined ? ` · 最大输出 ${maxOutput}` : ""}
          {model.test.at ? ` · ${new Date(model.test.at).toLocaleString("zh-CN")}` : ""}
        </span>
      </p>
    )
  if (model.test.status === "failed")
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-destructive">✗ {model.test.error ?? "测试失败"}</span>
      </p>
    )
  return (
    <p className="text-xs text-muted-foreground">
      {inChain ? "参数已改，建议重新测试后再启用" : "尚未测试连通 — 测通后才能启用"}
    </p>
  )
}

// 启用开关：未测试通过时禁用，并用 Tooltip 说明门槛。
function EnableSwitch({ model, busy, onToggleEnable }: { model: ModelEntry; busy: boolean; onToggleEnable: (v: boolean) => void }) {
  const enableAllowed = canEnable(model)
  const switchEl = (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch checked={model.enabled} disabled={!enableAllowed || busy} onCheckedChange={onToggleEnable} />
      {model.enabled ? "已启用" : enableAllowed ? "未启用" : "需先测通"}
    </label>
  )
  if (enableAllowed) return switchEl
  return (
    <Tooltip>
      <TooltipTrigger render={switchEl} />
      <TooltipContent side="top">请先测试通过</TooltipContent>
    </Tooltip>
  )
}

// 加入/已在运行编排的行动点：只有 enabled+已测通 才能加入；已在链中则提示，不重复加入。
function AddToChainRow({ model, inChain, onAddToChain }: { model: ModelEntry; inChain: boolean; onAddToChain: () => void }) {
  if (inChain)
    return (
      <p className="text-xs text-muted-foreground">
        <Badge variant="outline" className="font-normal">
          已在运行编排中
        </Badge>
      </p>
    )
  // 不满足条件时按钮禁用+说明原因,而不是整个消失——否则(实测)删掉链上唯一模型后,
  // 新模型「测通但未启用」时用户找不到任何编排入口。
  const blocked = model.test.status !== "passed" ? "测试通过并启用后可加入" : !model.enabled ? "启用后可加入编排" : null
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="outline" className="w-fit" disabled={!!blocked} onClick={onAddToChain}>
        <PlusCircle data-icon="inline-start" />
        加入运行编排
      </Button>
      {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
    </span>
  )
}

// 拉取可用模型的共享状态机（loading/结果列表/错误）：自建端点与内置服务商共用同一套状态，
// 差异只在传给 adminApi.models.listModels 的参数（自建带 baseUrl/apiKey，内置只带 provider）。
function useModelListFetch(fetchFn: () => Promise<{ ok: boolean; models?: string[]; error?: string }>, fallbackError: string) {
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setFetching(true)
    setError(null)
    try {
      const res = await fetchFn()
      if (res.ok && res.models) setModels(res.models)
      else setError(res.error ?? fallbackError)
    } catch {
      setError("请求失败，请重试")
    } finally {
      setFetching(false)
    }
  }
  return { models, fetching, error, run }
}

// 拉取结果下拉 + 错误提示，自建端点与内置服务商共用的展示片段。
function FetchedModelsPicker({
  models,
  error,
  value,
  onSelect,
}: {
  models: string[]
  error: string | null
  value: string
  onSelect: (v: string) => void
}) {
  return (
    <>
      {models.length > 0 && (
        <Select value={value || undefined} onValueChange={(v) => v && onSelect(v)}>
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder="从拉取结果中选择" />
          </SelectTrigger>
          <SelectContent>
            {models.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  )
}

// 自建端点专属字段（仅编辑态 + 自建模式渲染）：base_url + api_key 输入、拉取可用模型下拉。
// 下拉选中项与卡片头手填的 model 输入写同一个 draft.model 字段——二者并存，谁后写生效。
function CustomEndpointFields({
  draft,
  setDraft,
}: {
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
}) {
  // 已保存条目 apiKey 打码不回显：本地无明文时带 id，让服务端从库回填 key（apiKeyHint 存在即证明库里有 key）。
  const hasUsableKey = !!draft.apiKey || !!draft.apiKeyHint
  const { models, fetching, error, run } = useModelListFetch(
    () => adminApi.models.listModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, id: draft.id }),
    "拉取失败，请检查 URL / Key",
  )

  async function fetchModels() {
    if (!draft.baseUrl || !hasUsableKey) return
    await run()
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledInput
          label="Base URL"
          placeholder="http://host:port/v1"
          value={draft.baseUrl ?? ""}
          onChange={(v) => setDraft((d) => resetTestOnEdit({ ...d, baseUrl: v || undefined }))}
        />
        <LabeledInput
          label="API Key"
          type="password"
          placeholder={draft.apiKeyHint ? `当前 ${draft.apiKeyHint}，留空则不修改` : "sk-..."}
          value={draft.apiKey ?? ""}
          onChange={(v) => setDraft((d) => resetTestOnEdit({ ...d, apiKey: v || undefined }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!draft.baseUrl || !hasUsableKey || fetching}
          onClick={fetchModels}
        >
          {fetching ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
          拉取可用模型
        </Button>
        <FetchedModelsPicker
          models={models}
          error={error}
          value={draft.model}
          onSelect={(v) => setDraft((d) => resetTestOnEdit({ ...d, model: v }))}
        />
      </div>
    </div>
  )
}

// 内置服务商（deepseek/qwen/glm）可选覆盖 base_url/api_key（Task 1）：留空分别回退注册表默认地址
// （providerDefaultBaseUrl 做 placeholder）/ 服务端 env key。样式与 CustomEndpointFields 的
// LabeledInput 一致；下方保留原有「拉取可用模型」——provider 覆盖了 baseUrl 后拉取入口不变
// （只带 provider，由 agent 侧解析实际生效的 base_url/key，前端无需关心）。
function BuiltinEndpointFields({
  draft,
  setDraft,
}: {
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledInput
          label="Base URL"
          placeholder={providerDefaultBaseUrl(draft.provider) || "留空用默认地址"}
          value={draft.baseUrl ?? ""}
          onChange={(v) => setDraft((d) => resetTestOnEdit({ ...d, baseUrl: v || undefined }))}
        />
        <LabeledInput
          label="API Key"
          type="password"
          placeholder={draft.apiKeyHint ? `当前 ${draft.apiKeyHint}，留空则不修改` : "留空用服务端默认（env）"}
          value={draft.apiKey ?? ""}
          onChange={(v) => setDraft((d) => resetTestOnEdit({ ...d, apiKey: v || undefined }))}
        />
      </div>
      <BuiltinModelFetch draft={draft} setDraft={setDraft} />
    </div>
  )
}

// 内置服务商（deepseek/qwen/glm）拉取可用模型：agent 侧按注册表解析 base_url + 服务端 env 取 key，
// 前端只需带 provider，无需 base_url/api_key。与手填的 model 输入（在卡片头）并存，谁后写生效。
function BuiltinModelFetch({
  draft,
  setDraft,
}: {
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
}) {
  const { models, fetching, error, run } = useModelListFetch(
    () => adminApi.models.listModels({ provider: draft.provider }),
    "该服务商暂不支持自动拉取，请手填模型名",
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" type="button" disabled={fetching} onClick={run}>
        {fetching ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
        拉取可用模型
      </Button>
      <FetchedModelsPicker
        models={models}
        error={error}
        value={draft.model}
        onSelect={(v) => setDraft((d) => resetTestOnEdit({ ...d, model: v }))}
      />
    </div>
  )
}

// 两输入字段（Base URL / API Key）共用的小号 label+input 组合。
function LabeledInput({
  label,
  value,
  placeholder,
  onChange,
  type = "text",
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        className="h-8 text-xs"
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
