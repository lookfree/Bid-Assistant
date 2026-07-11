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
  // 是否有其它整份 PUT 正在进行（保存参数/保存运行配置）：期间禁用会产生写冲突的操作，避免并发覆盖。
  busy: boolean
  onTest: () => void
  onToggleEnable: (v: boolean) => void
  onSave: (next: ModelEntry) => void
  onDelete: () => void
  onAddToChain: () => void
}

export function ModelCard({ model, isNew, inChain, testing, tokens, busy, onTest, onToggleEnable, onSave, onDelete, onAddToChain }: CardProps) {
  const [editing, setEditing] = useState(isNew)
  const [draft, setDraft] = useState<ModelEntry>(model)

  function startEdit() {
    setDraft(model)
    setEditing(true)
  }

  function commit() {
    const changed =
      draft.provider !== model.provider ||
      draft.model !== model.model ||
      draft.baseUrl !== model.baseUrl ||
      draft.apiKey !== model.apiKey ||
      JSON.stringify(draft.params) !== JSON.stringify(model.params)
    onSave(changed ? resetTestOnEdit(draft) : draft)
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
        <TestStatusChip model={model} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4">
        <ParamsGrid editing={editing} model={model} draft={draft} setDraft={setDraft} />
        {editing && isCustomEntry(draft) && <CustomEndpointFields draft={draft} setDraft={setDraft} />}
        <TestLine model={model} inChain={inChain} tokens={tokens} />

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <CardActions
            editing={editing}
            busy={busy}
            testing={testing}
            model={model}
            onTest={onTest}
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
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
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
// 测试状态的失效交给 commit() 里既有的 diff 逻辑（provider 变了即视为 changed），这里不用重复处理。
function switchProvider(d: ModelEntry, nextProvider: string): ModelEntry {
  if (nextProvider === d.provider) return d
  if (nextProvider === "custom") return { ...d, provider: nextProvider, model: "" }
  return { ...d, provider: nextProvider, baseUrl: undefined, apiKey: undefined, apiKeyHint: undefined }
}

// 三个参数（temperature/max_tokens/top_p）：只读展示 or 编辑输入框，取决于 editing。
function ParamsGrid({
  editing,
  model,
  draft,
  setDraft,
}: {
  editing: boolean
  model: ModelEntry
  draft: ModelEntry
  setDraft: (updater: (d: ModelEntry) => ModelEntry) => void
}) {
  if (!editing)
    return (
      <div className="grid grid-cols-3 gap-2">
        <ParamView paramKey="temperature" value={model.params.temperature} />
        <ParamView paramKey="maxTokens" value={model.params.maxTokens} />
        <ParamView paramKey="topP" value={model.params.topP} />
      </div>
    )
  const setParam = (key: keyof ModelEntry["params"]) => (v: number) => setDraft((d) => ({ ...d, params: { ...d.params, [key]: v } }))
  return (
    <div className="grid grid-cols-3 gap-2">
      <ParamEdit paramKey="temperature" value={draft.params.temperature} onChange={setParam("temperature")} />
      <ParamEdit paramKey="maxTokens" value={draft.params.maxTokens} onChange={setParam("maxTokens")} />
      <ParamEdit paramKey="topP" value={draft.params.topP} onChange={setParam("topP")} />
    </div>
  )
}

// 卡片底部行动按钮：编辑态显示保存/取消，非编辑态显示测试/编辑参数/删除。
function CardActions({
  editing,
  busy,
  testing,
  model,
  onTest,
  onDelete,
  startEdit,
  commit,
  cancel,
}: {
  editing: boolean
  busy: boolean
  testing: boolean
  model: ModelEntry
  onTest: () => void
  onDelete: () => void
  startEdit: () => void
  commit: () => void
  cancel: () => void
}) {
  if (editing)
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={commit} disabled={busy}>
          <Save data-icon="inline-start" />
          保存参数
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
          <X data-icon="inline-start" />
          取消
        </Button>
      </div>
    )
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
// 若参数已改（重置为 untested）且模型仍在编排链中，提示需要重测。tokens 为本会话瞬态值（可缺省）。
function TestLine({ model, inChain, tokens }: { model: ModelEntry; inChain: boolean; tokens?: number }) {
  if (model.test.status === "passed")
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-emerald-700">✓ 连通</span>
        <span className="tabular-nums">
          {model.test.latencyMs}ms
          {tokens !== undefined ? ` · ${tokens} tokens` : ""}
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
  if (!canAddToChain(model)) return null
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={onAddToChain}>
      <PlusCircle data-icon="inline-start" />
      加入运行编排
    </Button>
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
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  async function fetchModels() {
    if (!draft.baseUrl || !draft.apiKey) return
    setFetching(true)
    setFetchError(null)
    try {
      const res = await adminApi.models.listModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey })
      if (res.ok && res.models) setModels(res.models)
      else setFetchError(res.error ?? "拉取失败，请检查 URL / Key")
    } catch {
      setFetchError("请求失败，请重试")
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledInput
          label="Base URL"
          placeholder="http://host:port/v1"
          value={draft.baseUrl ?? ""}
          onChange={(v) => setDraft((d) => ({ ...d, baseUrl: v || undefined }))}
        />
        <LabeledInput
          label="API Key"
          type="password"
          placeholder={draft.apiKeyHint ? `当前 ${draft.apiKeyHint}，留空则不修改` : "sk-..."}
          value={draft.apiKey ?? ""}
          onChange={(v) => setDraft((d) => ({ ...d, apiKey: v || undefined }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!draft.baseUrl || !draft.apiKey || fetching}
          onClick={fetchModels}
        >
          {fetching ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
          拉取可用模型
        </Button>
        {models.length > 0 && (
          <Select value={draft.model || undefined} onValueChange={(v) => v && setDraft((d) => ({ ...d, model: v }))}>
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
      </div>
      {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}
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
