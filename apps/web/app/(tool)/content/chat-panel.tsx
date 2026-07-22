"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Bot, Library, Loader2, Send, User } from "lucide-react"
import { ApiError } from "@/lib/api-client"
import { rewriteChapter } from "@/lib/project"
import { notifyCreditsChanged } from "@/lib/use-step"
import { isQuestionNotInstruction, QUESTION_GUIDE_REPLY } from "@/lib/assistant-guard"

type ChatMsg = { role: "user" | "ai"; text: string; link?: { href: string; label: string } }

/**
 * AI 对话侧栏：真实项目走单章改写通道（POST /api/projects/:id/chapters/:chapterId/rewrite，
 * App 侧计费 25 积分）；改写成功由父组件替换该章正文并刷新余额。无项目（demo）只提示引导。
 */
export function ChatPanel({
  chapters,
  activeId,
  projectId,
  contentReady,
  balance,
  rewriteCost,
  onApply,
  refreshBalance,
  onOpenLibrary,
}: {
  chapters: { id: string; no: string; title: string }[]
  activeId: string
  projectId: string | null
  /** content 步已完成（真实改写通道可用；未完成后端会 409） */
  contentReady: boolean
  balance: number
  /** 单章改写单次消耗（credit_cost.rewrite 实时口径，由页面经 useMembership 提供） */
  rewriteCost: number
  /** 改写成功：把返回 html 替换目标章正文 */
  onApply: (chapterId: string, html: string) => void
  refreshBalance: () => void
  onOpenLibrary: () => void
}) {
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: "ai", text: "你好，我是智启元 · 投标助手。选中目标章节后输入改写指令（如「把响应时间改为15分钟」「本章更正式一些」），我会改写该章内容并直接替换正文。" },
  ])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  // 目标章节：默认跟随当前编辑章；用户可在下拉改选，切换编辑章后恢复跟随
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => setPicked(null), [activeId])
  const targetId = picked ?? activeId
  const target = chapters.find((c) => c.id === targetId) ?? chapters[0]

  const push = (m: ChatMsg) => setChat((prev) => [...prev, m])

  async function sendMessage() {
    const text = input.trim()
    if (!text || sending || !target) return
    push({ role: "user", text })
    setInput("")
    // 明显提问/闲聊 → 本地引导，不发起计费改写（误当问答机器人会白扣积分还重写正文）
    if (isQuestionNotInstruction(text)) {
      push({ role: "ai", text: QUESTION_GUIDE_REPLY })
      return
    }
    if (!projectId) {
      push({ role: "ai", text: "当前为示例体验，AI 改写需上传招标文件创建真实项目后使用。" })
      return
    }
    if (!contentReady) {
      push({ role: "ai", text: "正文尚未生成完成，请先完成本步生成后再改写。" })
      return
    }
    setSending(true)
    push({ role: "ai", text: `收到，正在改写「${target.no} ${target.title}」，本次消耗 ${rewriteCost} 积分…` })
    try {
      const r = await rewriteChapter(projectId, target.id, text)
      onApply(r.chapterId, r.html)
      // 广播全局扣费事件：侧边栏积分卡 + useMembership（底部栏/本面板余额）一起刷新。
      // 此前只调 refreshBalance（页面级），侧边栏停在旧值 → 同屏两个余额（生产实测）。
      notifyCreditsChanged()
      refreshBalance()
      push({ role: "ai", text: `已完成「${target.no} ${target.title}」的改写并替换正文（消耗 ${r.cost} 积分），可在编辑器继续微调。` })
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        push({ role: "ai", text: "积分余额不足，本次改写未执行。", link: { href: "/membership", label: "去充值" } })
      } else if (e instanceof ApiError && e.status === 409) {
        push({ role: "ai", text: "正文尚未生成完成，暂不能改写本章。" })
      } else if (e instanceof ApiError && e.code === "rewrite_not_html") {
        push({ role: "ai", text: "本次指令没有产出有效正文，积分已全额退还。请把要求写成修改指令再试，例如「把响应时间改为15分钟」。" })
      } else {
        push({ role: "ai", text: "改写失败，请稍后重试。" })
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <aside className="hidden min-h-0 flex-col rounded-2xl border border-border bg-card lg:flex">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg gradient-brand">
          <Bot className="size-4 text-white" />
        </span>
        <span className="text-sm font-semibold text-foreground">智启元 · 投标助手</span>
        {/* 目标章节选择（默认当前编辑章） */}
        <select
          value={targetId}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="选择改写目标章节"
          className="ml-auto max-w-36 truncate rounded-lg border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground outline-none focus:border-primary"
        >
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.no} {c.title}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {chat.map((m, i) => (
          <div key={i} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                m.role === "user" ? "bg-secondary" : "gradient-brand"
              }`}
            >
              {m.role === "user" ? <User className="size-3.5 text-foreground" /> : <Bot className="size-3.5 text-white" />}
            </span>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
              }`}
            >
              {m.text}
              {m.link && (
                <Link href={m.link.href} className="ml-1 font-medium text-primary hover:underline">
                  {m.link.label}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 快捷指令 */}
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
        <button
          onClick={onOpenLibrary}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 gradient-brand-soft px-2.5 py-1 text-[11px] font-medium text-primary transition-opacity hover:opacity-90"
        >
          <Library className="size-3" />
          从资料库插入
        </button>
        {["扩写本章", "更正式", "提炼要点", "补充案例"].map((q) => (
          <button
            key={q}
            onClick={() => setInput(q)}
            className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {q}
          </button>
        ))}
      </div>

      <div className="border-t border-border p-3">
        {projectId && (
          <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">
            本次改写消耗 {rewriteCost} 积分 · 余额 {balance} 积分
          </p>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:border-primary">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void sendMessage()
              }
            }}
            rows={1}
            disabled={sending}
            placeholder={target ? `针对「${target.title}」提出修改…` : "输入修改指令…"}
            className="max-h-24 min-h-0 flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <button
            onClick={() => void sendMessage()}
            disabled={!input.trim() || sending}
            aria-label="发送"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg gradient-brand text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </div>
    </aside>
  )
}
