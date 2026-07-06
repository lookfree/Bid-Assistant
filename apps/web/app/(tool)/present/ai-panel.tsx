"use client"

import { useState } from "react"
import { Library, PanelRightClose, PanelRightOpen, Send, Sparkles, Wand2 } from "lucide-react"

/** 右栏 · AI 协同侧栏（含折叠态）：针对当前页的改写指令与资料库插入入口。 */
export function AiPanel({ activeTitle, onOpenLibrary }: { activeTitle?: string; onOpenLibrary: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [input, setInput] = useState("")
  const [reply, setReply] = useState("")

  function run(cmd: string) {
    if (!activeTitle) return
    setReply(`已根据「${cmd}」优化本页要点与演讲备注，可在中栏查看并继续微调。`)
    setInput("")
  }

  if (collapsed)
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="hidden w-12 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-4 text-muted-foreground transition-colors hover:text-foreground lg:flex"
        aria-label="展开 AI 协同"
      >
        <PanelRightOpen className="size-5" />
        <span className="text-xs [writing-mode:vertical-rl]">AI 协同</span>
      </button>
    )

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-card lg:flex">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" />
          AI 协同
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="折叠"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-xs text-muted-foreground">针对当前页「{activeTitle}」改写优化：</p>
        <div className="mt-3 flex flex-col gap-2">
          {["更口语", "更突出亮点", "压缩到 1 分钟讲完", "补充数据支撑"].map((cmd) => (
            <button
              key={cmd}
              onClick={() => run(cmd)}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Wand2 className="size-3.5 text-primary" />
              {cmd}
            </button>
          ))}
        </div>

        <button
          onClick={onOpenLibrary}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 gradient-brand-soft px-3 py-2 text-xs font-semibold text-primary transition-opacity hover:opacity-90"
        >
          <Library className="size-3.5" />
          从资料库插入
        </button>

        {reply && (
          <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-foreground">
            {reply}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) run(input.trim())
            }}
            placeholder="描述你想怎么改这一页…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            onClick={() => input.trim() && run(input.trim())}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg gradient-brand text-white transition-opacity hover:opacity-90"
            aria-label="发送"
          >
            <Send className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}
