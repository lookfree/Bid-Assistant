"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Bot, Check, Library, Loader2, Send, User, X } from "lucide-react"
import { ApiError } from "@/lib/api-client"
import { rewriteChapter } from "@/lib/project"
import { notifyCreditsChanged } from "@/lib/use-step"
import { isQuestionNotInstruction, QUESTION_GUIDE_REPLY } from "@/lib/assistant-guard"

type ChatMsg = { role: "user" | "ai"; text: string; link?: { href: string; label: string } }
/** 待确认的改写结果：改写完成后先挂在这里，用户点「应用」才写回正文（此前是直接覆盖，
 *  用户既没机会看就被改了，编辑器还因重挂跳回文首、找不到改了哪——两条生产反馈）。 */
type Pending = { chapterId: string; label: string; html: string }

/**
 * AI 对话侧栏：真实项目走单章改写通道（POST /api/projects/:id/chapters/:chapterId/rewrite，
 * 2026-07-29 起不计费）。改写结果**先给预览、用户确认后**才由父组件替换该章正文。
 * 无项目（demo）只提示引导。
 */
export function ChatPanel({
  chapters,
  activeId,
  projectId,
  contentReady,
  balance,
  onApply,
  refreshBalance,
  onOpenLibrary,
}: {
  chapters: { id: string; no: string; title: string; system?: boolean }[]
  activeId: string
  projectId: string | null
  /** content 步已完成（真实改写通道可用；未完成后端会 409） */
  contentReady: boolean
  balance: number
  /** 用户确认后：把返回 html 替换目标章正文（父组件负责保住滚动位置） */
  onApply: (chapterId: string, html: string) => void
  refreshBalance: () => void
  onOpenLibrary: () => void
}) {
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: "ai", text: "你好，我是智启元 · 投标助手。选中目标章节后输入改写指令（如「把响应时间改为15分钟」「本章更正式一些」），我会先把改写结果给你过目，确认后再替换正文。" },
  ])
  /** 待确认的改写结果（同一时刻只保留最新一份） */
  const [pending, setPending] = useState<Pending | null>(null)
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  // 目标章节：默认跟随当前编辑章；用户可在下拉改选，切换编辑章后恢复跟随
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => setPicked(null), [activeId])
  const targetId = picked ?? activeId
  const target = chapters.find((c) => c.id === targetId) ?? chapters[0]

  const push = (m: ChatMsg) => setChat((prev) => [...prev, m])

/** 改写结果摘要：剥标签取纯文本（HTML 直接展示既看不懂又会撑爆侧栏）；过长截断。 */
function previewOf(html: string): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim()
  return text.length > 260 ? `${text.slice(0, 260)}…` : text || "（改写结果为空）"
}

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
    // 系统章（如附录 sys-creds）不接受对话改写（终审 I1 第三道门）：内容纯代码拼接，
    // 送进这条通道等于让模型幻写掉一份确定性资料——就地拦下，引导去用「刷新附录」。
    if (target.system) {
      push({ role: "ai", text: "附录章由系统维护，请使用「刷新附录」按钮更新，这里不支持对它下改写指令。" })
      return
    }
    setSending(true)
    push({ role: "ai", text: `收到，正在改写「${target.no} ${target.title}」…` })
    try {
      const r = await rewriteChapter(projectId, target.id, text)
      // 不直接覆盖正文：挂起待确认，由用户决定是否应用（生产反馈：没问过就改了）
      setPending({ chapterId: r.chapterId, label: `${target.no} ${target.title}`, html: r.html })
      // 余额刷新保留：改写虽已免费，但同屏余额口径仍应与服务端一致（将来恢复收费也不用再改这里）
      notifyCreditsChanged()
      refreshBalance()
      push({ role: "ai", text: `「${target.no} ${target.title}」已改写完成，请在下方确认后再替换正文。` })
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        push({ role: "ai", text: "积分余额不足，本次改写未执行。", link: { href: "/membership", label: "去充值" } })
      } else if (e instanceof ApiError && e.code === "feature_locked") {
        // 档位权益门禁（服务端按 plans.features 判定,未扣分）。文案不写死"专业版"——
        // 改写现已全档开放,403 只在运营显式关闭某档时出现（评审二轮:与会员页宣传自相矛盾）
        push({ role: "ai", text: "当前会员档位未包含 AI 逐章改写权益，本次未执行、未扣积分。", link: { href: "/membership", label: "查看会员权益" } })
      } else if (e instanceof ApiError && e.status === 409) {
        push({ role: "ai", text: "正文尚未生成完成，暂不能改写本章。" })
      } else if (e instanceof ApiError && e.code === "rewrite_not_instruction") {
        push({ role: "ai", text: "这看起来是提问而不是改写指令,本次未修改正文、积分已全额退还。想改正文请用指令句式,例如「把响应时间改为15分钟」。" })
      } else if (e instanceof ApiError && e.code === "rewrite_not_html") {
        push({ role: "ai", text: "本次指令没有产出有效正文，积分已全额退还。请把要求写成修改指令再试，例如「把响应时间改为15分钟」。" })
      } else if (e instanceof ApiError && e.code === "rewrite_truncated") {
        // 改写的单位是**整章**（chapters 按章 id 存整章 HTML），所以建议必须是"拆成两章"——
        // 说"拆成小节"是害人：小节是章内的 items，拆完输入量一点没少，用户白花钱重生成正文，
        // 下次改写照样撞同一堵墙。另外多章都报同一提示时，更可能是模型输出上限配小了。
        push({
          role: "ai",
          text: "模型没能完整改写本章，已放弃本次修改以免丢失后半章的内容。本章篇幅偏大时，可在「提纲生成」里把它拆成两章、重新生成正文后再改；若多个章节都出现此提示，请联系管理员检查模型的输出长度上限配置。",
        })
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
        {/* 待确认的改写：给出摘要预览与去留选择——不确认就绝不动正文 */}
        {pending && (
          <div className="rounded-xl border border-primary/30 gradient-brand-soft p-3">
            <p className="text-xs font-semibold text-foreground">改写结果待确认 · {pending.label}</p>
            <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2 text-[11px] leading-relaxed text-muted-foreground">
              {previewOf(pending.html)}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                onClick={() => {
                  onApply(pending.chapterId, pending.html)
                  setPending(null)
                  push({ role: "ai", text: `已替换「${pending.label}」的正文，可在编辑器继续微调；不满意可用编辑器的撤销回退。` })
                }}
                className="inline-flex items-center gap-1 rounded-lg gradient-brand px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Check className="size-3.5" />
                应用到正文
              </button>
              <button
                onClick={() => {
                  setPending(null)
                  push({ role: "ai", text: "已放弃本次改写，正文未做任何改动。" })
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <X className="size-3.5" />
                放弃
              </button>
            </div>
          </div>
        )}
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
            改写不消耗积分 · 余额 {balance} 积分
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
