"use client"

import { useEffect, useRef, useState } from "react"
import { FolderOpen, Loader2, UploadCloud } from "lucide-react"
import { listProjects, setCurrentProjectId, createReviewProject, type ProjectListItem } from "@/lib/project"
import { uploadFile, uploadErrorMessage, uploadHint, ACCEPT_BID, ACCEPT_TENDER } from "@/lib/files"

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
  /** 招标文件必传（审查：废标体检要逐条比对招标要求，两者一体，缺一不可） */
  tenderRequired?: boolean
  submitLabel: string
  /** 附了招标文件时的提交按钮文案（仅 !bidOnly 时可能用到）。 */
  submitLabelWithTender?: string
}

/** 独立操作入口（spec328 独立审查 + 独立述标共用）：
 *  ① 选择「我的标书」里符合条件的项目直接操作（走既有流程）；
 *  ② 上传线下标书（bidOnly=false 时可附招标文件先读标；bidOnly=true 只传标书直接操作）。 */
export function StandaloneBidEntry(props: StandaloneBidEntryProps) {
  const { onBack, backLabel, noTenderHref, pickTitle, pickDesc, emptyHint, isSelectable, readyLabel } = props
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

  // ?focus=pick|upload：**只渲染用户点进来的那一张**（用户口径：从我的标书点进来就只看列表——
  // 上传入口在工具页首屏本来就有，再并排摆一张是重复且分散注意）。
  // 不带 focus（没有当前项目直接落到本页）才两张都给：那时用户还没表达意图，两条路都要留。
  const focus = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("focus")
  const showPick = focus !== "upload"
  const showUpload = focus !== "pick"

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button onClick={onBack} className="self-start text-xs font-medium text-primary hover:underline">
          {backLabel}
        </button>
      )}
      <div className={`grid gap-4${showPick && showUpload ? " lg:grid-cols-2" : ""}`}>
        {showPick && (
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
                    // 切当前项目后进入本工具工作视图（原 reload 同址）：审查页默认已改为独立入口，
                    // reload 回 /risk 会再落回入口，故统一走 noTenderHref（risk 带 ?view=project 直连该项目审查）。
                    window.location.href = noTenderHref
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
        )}
        {showUpload && <UploadBidCard {...props} />}
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
  tenderRequired,
  submitLabel,
  submitLabelWithTender,
}: StandaloneBidEntryProps) {
  const bidRef = useRef<HTMLInputElement>(null)
  const tenderRef = useRef<HTMLInputElement>(null)
  const [bidFiles, setBidFiles] = useState<File[]>([])
  const [tenderFile, setTenderFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!bidFiles.length || busy) return
    if (tenderRequired && !tenderFile) return
    setBusy(true)
    setError(null)
    try {
      const useTender = !bidOnly && tenderFile
      const [bids, tender] = await Promise.all([
        Promise.all(bidFiles.map(uploadFile)), // 顺序即拼接顺序（商务标/技术标分册）
        useTender ? uploadFile(tenderFile) : null,
      ])
      const id = await createReviewProject(bids.map((f) => f.key), tender ? [tender.key] : [])
      setCurrentProjectId(id)
      // 带招标文件（仅 !bidOnly）：先去读标（读完自动接续本工具的步）；否则直接去本工具页
      window.location.href = tender ? "/read" : noTenderHref
    } catch (e) {
      setError(uploadErrorMessage(e, "创建失败，请重试"))
      setBusy(false)
    }
  }

  const fileBtn = (label: string, picked: string | null, onClick: () => void, hint: string) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40"
    >
      <span className={picked ? "truncate text-foreground" : "text-muted-foreground"}>{picked ?? `${label}${hint}`}</span>
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
        {fileBtn(
          "选择投标文件",
          bidFiles.length ? `已选 ${bidFiles.length} 个文件：${bidFiles.map((f) => f.name).join("、")}` : null,
          () => bidRef.current?.click(),
          "（必选，可多选）",
        )}
        {!bidOnly && fileBtn("选择招标文件", tenderFile?.name ?? null, () => tenderRef.current?.click(), tenderHint ?? "（可选）")}
        <input ref={bidRef} type="file" accept={ACCEPT_BID} multiple className="hidden" onChange={(e) => { setBidFiles(Array.from(e.target.files ?? [])); e.target.value = "" /* 允许重选同名文件 */ }} />
        <input ref={tenderRef} type="file" accept={ACCEPT_TENDER} className="hidden" onChange={(e) => { setTenderFile(e.target.files?.[0] ?? null); e.target.value = "" }} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{uploadHint(bidOnly ? ACCEPT_BID : ACCEPT_TENDER)}</p>
      {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={!bidFiles.length || busy || (tenderRequired && !tenderFile)}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
        {busy ? "正在上传并创建…" : !bidOnly && tenderFile ? (submitLabelWithTender ?? submitLabel) : submitLabel}
      </button>
    </section>
  )
}
