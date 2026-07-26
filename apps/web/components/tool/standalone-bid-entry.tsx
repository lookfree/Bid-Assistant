"use client"

import { useEffect, useRef, useState } from "react"
import { FolderOpen, Loader2, UploadCloud } from "lucide-react"
import { listProjects, setCurrentProjectId, createReviewProject, type ProjectListItem } from "@/lib/project"
import { uploadFile, uploadErrorMessage } from "@/lib/files"

export type StandaloneBidEntryProps = {
  onBack?: () => void
  /** 返回按钮文案（各工具页自定，如「← 返回当前项目的审查 / 述标」）。 */
  backLabel: string
  /** 创建后跳转目标：bidOnly 时统一去此页；否则不附招标文件也去此页、附了先去 /read。 */
  noTenderHref: string
  pickTitle: string
  pickDesc: string
  emptyHint: string
  isSelectable: (p: ProjectListItem) => boolean
  readyLabel: string
  uploadTitle: string
  uploadDesc: string
  /** true=只传标书、不提供招标文件（述标用）：直接去 noTenderHref，不走 /read 对照绕路。 */
  bidOnly?: boolean
  /** 招标文件可选项的提示（仅 !bidOnly 时展示）。 */
  tenderHint?: string
  submitLabel: string
  /** 附了招标文件时的提交按钮文案（仅 !bidOnly 时可能用到）。 */
  submitLabelWithTender?: string
}

/** 独立操作入口（spec328 独立审查 + 独立述标共用）：
 *  ① 选择「我的标书」里符合条件的项目直接操作（走既有流程）；
 *  ② 上传线下标书（bidOnly=false 时可附招标文件先读标；bidOnly=true 只传标书直接操作）。 */
export function StandaloneBidEntry(props: StandaloneBidEntryProps) {
  const { onBack, backLabel, pickTitle, pickDesc, emptyHint, isSelectable, readyLabel } = props
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loadingList, setLoadingList] = useState(true)

  useEffect(() => {
    let alive = true
    listProjects(1, 50)
      .then((r) => {
        if (!alive) return
        setProjects(r.items.filter(isSelectable)) // isSelectable 只在挂载时用一次；调用方传的是纯函数
      })
      .catch(() => {})
      .finally(() => alive && setLoadingList(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button onClick={onBack} className="self-start text-xs font-medium text-primary hover:underline">
          {backLabel}
        </button>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FolderOpen className="size-4 text-primary" />
            {pickTitle}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{pickDesc}</p>
          <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
            {loadingList ? (
              <p className="py-6 text-center text-xs text-muted-foreground">加载中…</p>
            ) : projects.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{emptyHint}</p>
            ) : (
              projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setCurrentProjectId(p.id)
                    window.location.reload() // 切当前项目后整页按既有流程重载
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40"
                >
                  <span className="min-w-0 truncate text-sm text-foreground">{p.name}</span>
                  <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                    {p.currentStep === "done" ? "已完成" : readyLabel}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
        <UploadBidCard {...props} />
      </div>
    </div>
  )
}

/** 上传线下标书卡：标书必传；bidOnly 时不提供招标文件、直接去 noTenderHref。 */
function UploadBidCard({
  noTenderHref,
  uploadTitle,
  uploadDesc,
  bidOnly,
  tenderHint,
  submitLabel,
  submitLabelWithTender,
}: StandaloneBidEntryProps) {
  const bidRef = useRef<HTMLInputElement>(null)
  const tenderRef = useRef<HTMLInputElement>(null)
  const [bidFile, setBidFile] = useState<File | null>(null)
  const [tenderFile, setTenderFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!bidFile || busy) return
    setBusy(true)
    setError(null)
    try {
      const useTender = !bidOnly && tenderFile
      const [bid, tender] = await Promise.all([uploadFile(bidFile), useTender ? uploadFile(tenderFile) : null])
      const id = await createReviewProject(bid.key, tender?.key)
      setCurrentProjectId(id)
      // 带招标文件（仅 !bidOnly）：先去读标（读完自动接续本工具的步）；否则直接去本工具页
      window.location.href = tender ? "/read" : noTenderHref
    } catch (e) {
      setError(uploadErrorMessage(e, "创建失败，请重试"))
      setBusy(false)
    }
  }

  const fileBtn = (label: string, file: File | null, onClick: () => void, hint: string) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40"
    >
      <span className={file ? "truncate text-foreground" : "text-muted-foreground"}>{file ? file.name : `${label}${hint}`}</span>
      <UploadCloud className="ml-2 size-4 shrink-0 text-muted-foreground" />
    </button>
  )

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <UploadCloud className="size-4 text-primary" />
        {uploadTitle}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{uploadDesc}</p>
      <div className="mt-3 space-y-2">
        {fileBtn("选择投标文件", bidFile, () => bidRef.current?.click(), "（必选）")}
        {!bidOnly && fileBtn("选择招标文件", tenderFile, () => tenderRef.current?.click(), tenderHint ?? "（可选）")}
        <input ref={bidRef} type="file" accept=".doc,.docx,.pdf" className="hidden" onChange={(e) => { setBidFile(e.target.files?.[0] ?? null); e.target.value = "" /* 允许重选同名文件 */ }} />
        <input ref={tenderRef} type="file" accept=".doc,.docx,.pdf,.xls,.xlsx" className="hidden" onChange={(e) => { setTenderFile(e.target.files?.[0] ?? null); e.target.value = "" }} />
      </div>
      {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={!bidFile || busy}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
        {busy ? "正在上传并创建…" : !bidOnly && tenderFile ? (submitLabelWithTender ?? submitLabel) : submitLabel}
      </button>
    </section>
  )
}
