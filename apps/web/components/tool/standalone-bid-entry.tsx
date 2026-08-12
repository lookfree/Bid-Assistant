"use client"

import { useEffect, useRef, useState } from "react"
import { FolderOpen, Loader2, UploadCloud, X } from "lucide-react"
import { listProjects, setCurrentProjectId, createReviewProject, type ProjectListItem } from "@/lib/project"
import { fileSummary, fileTitle } from "@/lib/project-files"
import { clearUploading, markUploading } from "@/lib/upload-progress"
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
  /** 尚未跑过本步时的标记，如「可审查」「可述标」 */
  readyLabel: string
  /** 本步的 key 与已跑过时的标记（如 review/「已审查」）：只看 currentStep 会标错——
   *  审查跑完 currentStep 就推进到 present，那份标书仍会显示「可审查」（用户实测）。 */
  doneStep: "review" | "present"
  doneLabel: string
  /** 上传卡文案：**给了 uploadHref 就不需要**（那时本入口不自带上传卡）。 */
  uploadTitle?: string
  uploadDesc?: string
  /** true=只传标书、不提供招标文件（述标用）：直接去 noTenderHref，不走 /read 对照绕路。 */
  bidOnly?: boolean
  /** 招标文件可选项的提示（仅 !bidOnly 时展示）。 */
  tenderHint?: string
  /** 招标文件必传（审查：废标体检要逐条比对招标要求，两者一体，缺一不可） */
  tenderRequired?: boolean
  /** 列表卡底部「改为上传」的文案：各页要求不同（审查要连招标文件一起传），不能写死在共享组件里 */
  switchToUploadLabel: string
  /** 给定则本入口**不再自带上传卡**，「改为上传」变成跳到该地址的链接。
   *  审查页用：那边的标准版面板已经是唯一的上传入口（原地跑读标+体检、价格写明），
   *  这里再放一张上传卡就是重复品，且行为不一致（旧卡创建完会把用户甩去 /read）——
   *  两个入口并存曾让用户以为"审查非得先跑一趟招标解读"（2026-08-11 用户实测反馈）。 */
  uploadHref?: string
  submitLabel?: string
  /** 附了招标文件时的提交按钮文案（仅 !bidOnly 时可能用到）。 */
  submitLabelWithTender?: string
}

/** 独立操作入口（spec328 独立审查 + 独立述标共用）：
 *  ① 选择「我的标书」里符合条件的项目直接操作（走既有流程）；
 *  ② 上传线下标书（bidOnly=false 时可附招标文件；创建后一律回本工具页，读标由本工具页一并跑掉）。 */
export function StandaloneBidEntry(props: StandaloneBidEntryProps) {
  const { onBack, backLabel, noTenderHref, pickTitle, pickDesc, emptyHint, isSelectable, readyLabel,
    switchToUploadLabel, doneStep, doneLabel, uploadHref } = props
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

  // **任何时候只显示一张卡**（用户口径：两卡并排那页不需要了）。?focus=upload 只作**初值**，
  // 之后在组件内切换：整页跳转会重跑鉴权、重拉项目列表，为一次纯 UI 切换付这个代价没道理，
  // 而且跳过去就只剩上传卡、没有回列表的路（评审：单向的"路径不丢"等于走进死胡同）。
  // uploadHref 模式下本入口不自带上传卡，?focus=upload 也不许把它唤出来（否则又冒出重复入口）。
  const [showUpload, setShowUpload] = useState(
    () => !props.uploadHref && typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("focus") === "upload",
  )

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button onClick={onBack} className="self-start text-xs font-medium text-primary hover:underline">
          {backLabel}
        </button>
      )}
      <div>
        {!showUpload && (
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground" title={p.name}>{p.name}</span>
                    {/* 这一行名字是派生的：生成项目显示招标文件名、线下项目显示投标文件名。
                        不点明是哪一类、有几份，用户无从判断自己选的这条到底拿什么去审查。 */}
                    <span className="block truncate text-[11px] text-muted-foreground" title={fileTitle(p)}>
                      {fileSummary(p)}
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                    {p.doneSteps?.includes(doneStep) ? doneLabel : p.currentStep === "done" ? "已完成" : readyLabel}
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            onClick={() => { if (uploadHref) window.location.href = uploadHref; else setShowUpload(true) }}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <UploadCloud className="size-3.5" />
            {switchToUploadLabel}
          </button>
        </section>
        )}
        {showUpload && props.uploadTitle && (
          <div className="flex flex-col gap-2">
            <UploadBidCard {...props} />
            <button
              onClick={() => setShowUpload(false)}
              className="self-center text-xs font-medium text-primary hover:underline"
            >
              ← 返回，从我的标书里选
            </button>
          </div>
        )}
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
    const home = noTenderHref.split("?")[0]!   // 上传归属的页面（/present、/risk…）
    markUploading(home)
    try {
      const useTender = !bidOnly && tenderFile
      const [bids, tender] = await Promise.all([
        Promise.all(bidFiles.map(uploadFile)), // 顺序即拼接顺序（商务标/技术标分册）
        useTender ? uploadFile(tenderFile) : null,
      ])
      const id = await createReviewProject(bids.map((f) => f.key), tender ? [tender.key] : [])
      setCurrentProjectId(id)
      clearUploading()
      // 一律回本工具页，**带招标文件也不再绕去 /read**：读标由本工具页的「开始对照审查」一并跑掉。
      // 此前带招标文件时硬跳 /read，用户得等它跑完再自己找回来点生成，中间还容易以为没传成功又传一遍
      // （2026-08-08 已在标准版那张卡改掉，这个共用入口漏了，两个入口行为不一致——用户实测发现）。
      // 只在用户还留在本工具页时才跳：切菜单会卸载本组件，但这段 async 照样跑完，
      // 那时把浏览器从资料库/会员中心强行拽走比不跳更糟（项目已建好且已设为当前项目）。
      if (window.location.pathname.startsWith(home)) window.location.href = noTenderHref
    } catch (e) {
      clearUploading()
      setError(uploadErrorMessage(e, "创建失败，请重试"))
      setBusy(false)
    }
  }

  // 选完必须能撤销：此前选错文件（如把招标文件选进投标文件槽）就再也改不掉，只能刷新整页
  // ——整个面板没有任何清除入口（2026-08-06 用户反馈）。
  const fileBtn = (label: string, picked: string | null, onClick: () => void, hint: string, onClear?: () => void) => (
    <div className="flex w-full items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 transition-colors hover:border-primary/40">
      <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left text-sm">
        <span className={picked ? "block truncate text-foreground" : "text-muted-foreground"}>
          {picked ?? `${label}${hint}`}
        </span>
      </button>
      {picked && onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`清除已选的${label}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <X className="size-4" />
        </button>
      ) : (
        <UploadCloud className="ml-1 size-4 shrink-0 text-muted-foreground" />
      )}
    </div>
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
          () => setBidFiles([]),
        )}
        {!bidOnly &&
          fileBtn("选择招标文件", tenderFile?.name ?? null, () => tenderRef.current?.click(), tenderHint ?? "（可选）", () => setTenderFile(null))}
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
