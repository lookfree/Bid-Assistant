import { Info } from "lucide-react"
import { cn } from "@/lib/utils"

// AI 生成内容显式标识（算法备案要求，图5/6）：系统自动渲染，无关闭按钮、无 localStorage 开关。
export function AiNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "mt-3 flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>本内容由智启元投标助手生成合成类算法辅助生成，仅供投标文件编制参考，请结合招标文件原文和企业实际情况复核确认后使用。</span>
    </div>
  )
}
