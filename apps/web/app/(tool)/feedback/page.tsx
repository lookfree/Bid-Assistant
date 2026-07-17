"use client"

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { MessageSquareText, Loader2 } from "lucide-react"
import { ApiError } from "@/lib/api-client"
import { feedbackApi, FEEDBACK_TYPES, type FeedbackItem, type FeedbackType } from "@/lib/feedback-api"
import { StatusBadge } from "@/components/status-badge"

const TYPE_LABEL: Record<FeedbackType, string> = {
  content_error: "内容问题",
  complaint: "投诉",
  billing: "计费问题",
  suggestion: "建议",
  other: "其他",
}

const STATUS_LABEL: Record<FeedbackItem["status"], string> = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已解决",
}

const STATUS_TONE: Record<FeedbackItem["status"], "warning" | "progress" | "success"> = {
  pending: "warning",
  processing: "progress",
  resolved: "success",
}

// 帮助与反馈页（spec326 C 端半边）：算法备案要求的用户申诉/反馈入口，money-blind。
export default function FeedbackPage() {
  const { items, listLoading, listError, loadList } = useFeedbackList()

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl gradient-brand">
          <MessageSquareText className="size-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">帮助与反馈</h1>
          <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
            生成内容问题、扣费异常、投诉或建议，都可以在这里提交，我们会尽快处理
          </p>
        </div>
      </div>

      <FeedbackForm onSubmitted={loadList} />

      <section className="mt-5 rounded-2xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
          <span className="text-sm font-semibold text-foreground">我的反馈</span>
        </header>
        <div className="flex flex-col gap-3 px-5 py-4">
          {listLoading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : listError ? (
            <p className="text-sm text-destructive">{listError}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有提交过反馈</p>
          ) : (
            items.map((item) => <FeedbackRow key={item.id} item={item} />)
          )}
        </div>
      </section>
    </div>
  )
}

/** 「我的反馈」数据源：挂载时拉 GET /api/feedback，提交成功后由表单回调重拉。 */
function useFeedbackList() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const r = await feedbackApi.list()
      setItems(r.items)
      setListError(null)
    } catch {
      setListError("加载反馈列表失败，请刷新重试")
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  return { items, listLoading, listError, loadList }
}

/** 反馈提交表单：类型 + 正文（必填）+ 联系方式（选填）；成功清空表单，429 特判提示。 */
function FeedbackForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [type, setType] = useState<FeedbackType>("content_error")
  const [content, setContent] = useState("")
  const [contact, setContact] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!content.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setSubmitted(false)
    try {
      await feedbackApi.submit({ type, content: content.trim(), contact: contact.trim() || undefined })
      setType("content_error")
      setContent("")
      setContact("")
      setSubmitted(true)
      onSubmitted()
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && err.code === "too_many_feedback") {
        setSubmitError("今日提交已达上限，请明日再试")
      } else {
        setSubmitError("提交失败，请稍后重试")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-border bg-card p-5">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <FeedbackFields
          type={type}
          onType={setType}
          content={content}
          onContent={setContent}
          contact={contact}
          onContact={setContact}
        />

        {submitError && <p className="text-xs font-medium text-destructive">{submitError}</p>}
        {submitted && <p className="text-xs font-medium text-success">提交成功，我们会尽快处理</p>}

        <button
          type="submit"
          disabled={submitting || !content.trim()}
          className="inline-flex w-fit items-center gap-1.5 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "提交中…" : "提交反馈"}
        </button>
      </form>
    </section>
  )
}

/** 表单字段区：类型（原生 select）/ 正文（必填 textarea）/ 联系方式（选填 input）。 */
function FeedbackFields({
  type,
  onType,
  content,
  onContent,
  contact,
  onContact,
}: {
  type: FeedbackType
  onType: (v: FeedbackType) => void
  content: string
  onContent: (v: string) => void
  contact: string
  onContact: (v: string) => void
}) {
  return (
    <>
      <div>
        <label className="block text-xs font-medium text-foreground">反馈类型</label>
        <select
          value={type}
          onChange={(e) => onType(e.target.value as FeedbackType)}
          aria-label="反馈类型"
          className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          {FEEDBACK_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-foreground">问题描述</label>
        <textarea
          value={content}
          onChange={(e) => onContent(e.target.value)}
          rows={5}
          maxLength={2000}
          required
          placeholder="请描述遇到的问题，例如具体章节、扣费记录或建议内容…"
          className="mt-1.5 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-foreground">联系方式（选填）</label>
        <input
          value={contact}
          onChange={(e) => onContact(e.target.value)}
          maxLength={100}
          placeholder="手机号或邮箱，方便我们回复你"
          className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>
    </>
  )
}

/** 「我的反馈」单条：类型/时间/状态徽章 + 正文 + 官方回复（仅 reply 非空时显示）。 */
function FeedbackRow({ item }: { item: FeedbackItem }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {TYPE_LABEL[item.type]}
        </span>
        <StatusBadge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</StatusBadge>
        <span className="ml-auto text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-foreground">{item.content}</p>
      {item.reply && (
        <div className="mt-2.5 rounded-lg bg-muted/60 p-3">
          <p className="text-xs font-medium text-foreground">官方回复</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.reply}</p>
        </div>
      )}
    </div>
  )
}
