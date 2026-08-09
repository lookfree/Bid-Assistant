import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// 三个参数字段的 Tooltip 说明文案（brief 指定原文，不可改写）。
export const PARAM_TOOLTIPS = {
  temperature:
    "采样温度（0–2）：越低越确定、稳定，适合结构化输出与正文；越高越发散、有创意。投标场景建议 0.5–0.8。",
  maxTokens:
    "单次回复最大输出 token 数：太小会截断长内容（如述标 PPT、长正文），按最长场景留足，常见 4096–8192。\n不同模型输出上限不同，请按所选模型的实际上限填写。",
  topP: "核采样 top_p（0–1）：只从累计概率前 p 的候选词里采样，1.0 表示不限制。一般与 temperature 二选一调整。",
} as const

type ParamKey = keyof typeof PARAM_TOOLTIPS

const PARAM_LABELS: Record<ParamKey, string> = {
  temperature: "temperature",
  maxTokens: "max_tokens",
  topP: "top_p",
}

// 只读展示态：数值 + 悬停 Tooltip 说明，用于卡片非编辑状态。
export function ParamView({ paramKey, value }: { paramKey: ParamKey; value: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="cursor-help rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
            <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {PARAM_LABELS[paramKey]}
            </div>
            <div className="text-[15px] font-semibold tabular-nums text-foreground">{value}</div>
          </div>
        }
      />
      <TooltipContent side="top" className="max-w-64 text-pretty">
        {PARAM_TOOLTIPS[paramKey]}
      </TooltipContent>
    </Tooltip>
  )
}

// 编辑态：数值输入框 + 同一份 Tooltip 说明（挂在 label 上）。
export function ParamEdit({
  paramKey,
  value,
  onChange,
}: {
  paramKey: ParamKey
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="w-fit cursor-help text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {PARAM_LABELS[paramKey]}
            </span>
          }
        />
        <TooltipContent side="top" className="max-w-64 text-pretty">
          {PARAM_TOOLTIPS[paramKey]}
        </TooltipContent>
      </Tooltip>
      <Input
        type="number"
        step={paramKey === "maxTokens" ? 1 : 0.1}
        className="h-6 border-0 bg-transparent p-0 text-[15px] font-semibold tabular-nums shadow-none focus-visible:ring-0"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  )
}

// 上下文窗口（tokens）：与上面三个采样参数并列展示但语义不同——唯一可留空的字段（留空=用运营
// 后台的全局默认窗口估算预算），所以单独一对组件而不复用 ParamView/ParamEdit（那两个的 value
// 是必填 number，装不下"未配置"这个状态）。表单形态照抄 maxTokens 字段（同样的输入框风格）。
export const CONTEXT_WINDOW_TOOLTIP =
  "该模型的最大上下文窗口（输入+输出总 token 数），决定审查/述标等步骤能喂多少正文进去。\n留空则按运营后台的全局默认窗口估算预算；模型实际窗口比全局默认小（如 32K 窗口的模型）时务必填写，否则预算会算多、请求可能因超出模型真实窗口而失败。"

export function ContextWindowView({ value }: { value?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="cursor-help rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
            <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              context_window
            </div>
            <div className="text-[15px] font-semibold tabular-nums text-foreground">
              {value ?? "用全局默认"}
            </div>
          </div>
        }
      />
      <TooltipContent side="top" className="max-w-64 text-pretty">
        {CONTEXT_WINDOW_TOOLTIP}
      </TooltipContent>
    </Tooltip>
  )
}

export function ContextWindowEdit({
  value,
  onChange,
}: {
  value?: number
  onChange: (v: number | undefined) => void
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="w-fit cursor-help text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              context_window
            </span>
          }
        />
        <TooltipContent side="top" className="max-w-64 text-pretty">
          {CONTEXT_WINDOW_TOOLTIP}
        </TooltipContent>
      </Tooltip>
      <Input
        type="number"
        step={1}
        placeholder="留空=用全局默认"
        className="h-6 border-0 bg-transparent p-0 text-[15px] font-semibold tabular-nums shadow-none placeholder:text-xs placeholder:font-normal focus-visible:ring-0"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim()
          onChange(raw === "" ? undefined : Math.max(1, Number(raw) || 0))
        }}
      />
    </div>
  )
}
