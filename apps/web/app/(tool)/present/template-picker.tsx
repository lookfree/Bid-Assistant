"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { Building2, Check, ChevronRight, History, Loader2, Lock, Palette, Upload, X } from "lucide-react"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { slideStyles, enterpriseTemplateStyle, type StyleId, type SlideStyle } from "@/lib/present"
import type { LibraryEntry } from "@/lib/library-api"

type TemplatePickerProps = {
  isMember: boolean
  currentStyleId: string
  refPpt: string | null
  libItems: LibraryEntry[]
  libLoading: boolean
  onClose: () => void
  onPickBuiltin: (id: StyleId) => void
  onPickEnterprise: (s: SlideStyle, itemId: string) => void
  onPickReference: (name: string) => void
  onUploadTemplate: (file: File) => Promise<void>
  onUploadReference: (file: File) => Promise<void>
  /** 会员权益 gate（加载中不判定、非会员跳会员页），返回是否放行 */
  ensureMember: () => boolean
}

/* 保存入库 / 上传参考的串行任务状态（真实请求的进行中与失败提示） */
function useBusyTask() {
  const [busy, setBusy] = useState(false)
  const [busyMsg, setBusyMsg] = useState<string | null>(null)

  async function run(msg: string, task: () => Promise<void>, failMsg: string) {
    if (busy) return
    setBusy(true)
    setBusyMsg(msg)
    try {
      await task()
      setBusyMsg(null)
    } catch {
      setBusyMsg(failMsg)
    } finally {
      setBusy(false)
    }
  }

  return { busy, busyMsg, run }
}

/**
 * 模板 / 参考选择器：内置预设 + 企业自有模板 + 参考历史述标 PPT。
 * 资料库条目由页面级 useLibrary 提升传入（presentation 分类）；
 * 企业模板/历史述标目前按 tags 契约区分（spec315 考虑改为子分类字段）。
 */
export function TemplatePicker(props: TemplatePickerProps) {
  const { onClose, libItems, libLoading, ensureMember } = props
  useEscapeClose(onClose)
  const presItems = libItems.filter((it) => it.category === "presentation")
  const enterpriseItems = presItems.filter((it) => it.tags?.includes("企业模板"))
  const historyItems = presItems.filter((it) => it.tags?.includes("历史述标"))

  const { busy, busyMsg, run } = useBusyTask()
  const refFileRef = useRef<HTMLInputElement>(null)
  const entFileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative z-10 flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Palette className="size-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">演示模板与参考</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <BuiltinSection currentStyleId={props.currentStyleId} onPickBuiltin={props.onPickBuiltin} />
          <EnterpriseSection
            isMember={props.isMember}
            currentStyleId={props.currentStyleId}
            items={enterpriseItems}
            loading={libLoading}
            onPickEnterprise={props.onPickEnterprise}
            onUploadClick={() => {
              if (ensureMember()) entFileRef.current?.click()
            }}
          />
          <HistorySection
            isMember={props.isMember}
            refPpt={props.refPpt}
            items={historyItems}
            loading={libLoading}
            onPickReference={props.onPickReference}
            onUploadClick={() => {
              if (ensureMember()) refFileRef.current?.click()
            }}
          />
          <input
            ref={refFileRef}
            type="file"
            accept=".pptx,.ppt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) void run("正在上传参考 PPT…", () => props.onUploadReference(file), "参考 PPT 上传失败，请重试")
            }}
          />
          <input
            ref={entFileRef}
            type="file"
            accept=".pptx,.potx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) void run("正在上传企业模板…", () => props.onUploadTemplate(file), "企业模板上传失败，请重试")
            }}
          />
          {busyMsg && (
            <p className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {busyMsg}
            </p>
          )}
        </div>

        <PickerFooter />
      </div>
    </div>
  )
}

/* 底部说明：能力边界 + 会员权益提示 */
function PickerFooter() {
  return (
    <div className="border-t border-border bg-muted/40 px-5 py-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        套用企业模板版式 + 参考要点结构，<span className="font-medium text-foreground">不承诺一键复刻原 PPT 设计</span>。
        企业模板、历史述标参考与上传模板为
        <Link href="/membership" className="mx-0.5 font-medium text-primary hover:underline">
          付费会员
        </Link>
        权益。
      </p>
    </div>
  )
}

/* 会员专享角标 */
function MemberBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      <Lock className="size-3" />
      会员专享
    </span>
  )
}

/* 内置预设 */
function BuiltinSection({ currentStyleId, onPickBuiltin }: { currentStyleId: string; onPickBuiltin: (id: StyleId) => void }) {
  return (
    <>
      <p className="text-xs font-semibold text-foreground">内置预设</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {slideStyles.map((s) => {
          const selected = currentStyleId === s.id
          return (
            <button
              key={s.id}
              onClick={() => onPickBuiltin(s.id as StyleId)}
              className={`flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors ${
                selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <span className={`h-8 w-full rounded-md ${s.coverBg}`} />
              <span className="flex w-full items-center justify-between text-xs font-medium text-foreground">
                {s.name}
                {selected && <Check className="size-3.5 text-primary" />}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

type EnterpriseSectionProps = {
  isMember: boolean
  currentStyleId: string
  items: LibraryEntry[]
  loading: boolean
  onPickEnterprise: (s: SlideStyle, itemId: string) => void
  onUploadClick: () => void
}

/* 企业模板行数据：资料库 presentation 分类下「企业模板」标签的条目，按条目 id 稳定哈希取预览配色。 */
function enterpriseRows(items: LibraryEntry[]) {
  return items.map((it) => ({ itemId: it.id, name: it.title, meta: it.meta ?? null, style: enterpriseTemplateStyle(it.id, it.title) }))
}

/* 企业自有模板：真实上传（presign+PUT）后即落资料库条目，重进选择器仍可见并可复用套版式。 */
function EnterpriseSection(props: EnterpriseSectionProps) {
  const { isMember, currentStyleId, loading } = props
  const rows = enterpriseRows(props.items)
  return (
    <>
      <div className="mt-5 flex items-center gap-2">
        <Building2 className="size-4 text-primary" />
        <p className="text-xs font-semibold text-foreground">企业自有模板</p>
        {!isMember && <MemberBadge />}
      </div>
      {loading && <p className="mt-2 text-xs text-muted-foreground">资料库加载中…</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {!loading && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">暂无企业模板，可在下方上传，或到「我的资料库 · 演示模板」录入</p>
        )}
        {rows.map((tpl) => {
          const selected = currentStyleId === tpl.style.id
          return (
            <button
              key={tpl.itemId}
              onClick={() => props.onPickEnterprise(tpl.style, tpl.itemId)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <span className={`h-10 w-14 shrink-0 rounded-md ${tpl.style.coverBg}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="truncate">{tpl.name}</span>
                  {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                  {!isMember && <Lock className="size-3 shrink-0 text-primary" />}
                </span>
                {tpl.meta && <span className="mt-0.5 block text-[11px] text-muted-foreground">{tpl.meta}</span>}
                <span className="mt-1 block text-[11px] text-primary">套用此模板版式</span>
              </span>
            </button>
          )
        })}
        {/* 上传企业模板 */}
        <button
          onClick={props.onUploadClick}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Upload className="size-4" />
          上传企业模板（.pptx / .potx）
          {!isMember && <Lock className="size-3 text-primary" />}
        </button>
      </div>
    </>
  )
}

/* 参考历史述标 PPT：资料库条目 + 真实上传入口 */
function HistorySection({
  isMember,
  refPpt,
  items,
  loading,
  onPickReference,
  onUploadClick,
}: {
  isMember: boolean
  refPpt: string | null
  items: LibraryEntry[]
  loading: boolean
  onPickReference: (name: string) => void
  onUploadClick: () => void
}) {
  return (
    <>
      <div className="mt-5 flex items-center gap-2">
        <History className="size-4 text-primary" />
        <p className="text-xs font-semibold text-foreground">参考历史述标 PPT</p>
        {!isMember && <MemberBadge />}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {loading && <p className="text-xs text-muted-foreground">资料库加载中…</p>}
        {!loading && items.length === 0 && (
          <p className="text-xs text-muted-foreground">暂无历史述标 PPT，可在下方上传后作为参考</p>
        )}
        {items.map((it) => {
          const selected = refPpt === it.title
          return (
            <button
              key={it.id}
              onClick={() => onPickReference(it.title)}
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${
                selected ? "border-primary/50 gradient-brand-soft" : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="truncate">{it.title}</span>
                  {!isMember && <Lock className="size-3 shrink-0 text-primary" />}
                </span>
                {it.meta && <span className="mt-0.5 block text-[11px] text-muted-foreground">{it.meta}</span>}
              </span>
              {selected ? (
                <Check className="size-4 shrink-0 text-primary" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          )
        })}
        <button
          onClick={onUploadClick}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Upload className="size-4" />
          上传参考 PPT（.pptx / .ppt）
          {!isMember && <Lock className="size-3 text-primary" />}
        </button>
      </div>
    </>
  )
}
