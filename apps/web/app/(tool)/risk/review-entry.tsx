"use client"

import { useEffect, useRef, useState } from "react"
import { FolderOpen, Loader2, UploadCloud } from "lucide-react"
import { listProjects, setCurrentProjectId, createReviewProject, type ProjectListItem } from "@/lib/project"
import { uploadFile, uploadErrorMessage } from "@/lib/files"

/** 标书审查独立入口（spec328）：无当前项目时展示——
 *  ① 选择「我的标书」里已生成正文的项目直接审查（走既有流程）；
 *  ② 上传线下生成的标书（可选附招标文件：附了做对照审查,先读标;不附做通用自查）。 */
export function ReviewEntry() {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loadingList, setLoadingList] = useState(true)
  useEffect(() => {
    let alive = true
    listProjects(1, 50)
      .then((r) => {
        if (!alive) return
        // 可审查 = 正文已生成（走到 review 及之后）；含已完成的审查专用项目（重看报告）
        setProjects(r.items.filter((p) => ["review", "present", "export", "done"].includes(p.currentStep)))
      })
      .catch(() => {})
      .finally(() => alive && setLoadingList(false))
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-border bg-card p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FolderOpen className="size-4 text-primary" />
          审查我的标书
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">选择已生成正文的项目，进入废标体检</p>
        <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
          {loadingList ? (
            <p className="py-6 text-center text-xs text-muted-foreground">加载中…</p>
          ) : projects.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无已生成正文的标书，可先上传线下标书审查</p>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setCurrentProjectId(p.id)
                  window.location.reload() // 切当前项目后整页按既有审查流程重载
                }}
                className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40"
              >
                <span className="min-w-0 truncate text-sm text-foreground">{p.name}</span>
                <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">{p.currentStep === "done" ? "已完成" : "可审查"}</span>
              </button>
            ))
          )}
        </div>
      </section>
      <UploadReviewCard />
    </div>
  )
}

/** 上传线下标书卡：标书必传,招标文件可选;创建审查项目后按模式跳转。 */
function UploadReviewCard() {
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
      const bid = await uploadFile(bidFile)
      const tender = tenderFile ? await uploadFile(tenderFile) : null
      const id = await createReviewProject(bid.key, tender?.key)
      setCurrentProjectId(id)
      // 带招标文件：先去读标（读完自动接审查步）;不带：留在本页直接可点体检
      window.location.href = tender ? "/read" : "/risk"
    } catch (e) {
      setError(uploadErrorMessage(e, "创建审查失败，请重试"))
      setBusy(false)
    }
  }

  const fileBtn = (label: string, file: File | null, onClick: () => void, required: boolean) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40"
    >
      <span className={file ? "truncate text-foreground" : "text-muted-foreground"}>
        {file ? file.name : `${label}${required ? "（必选）" : "（可选，附上可做对照审查）"}`}
      </span>
      <UploadCloud className="ml-2 size-4 shrink-0 text-muted-foreground" />
    </button>
  )

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <UploadCloud className="size-4 text-primary" />
        审查线下标书
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        上传线下制作的投标文件进行废标体检；附上对应招标文件可做逐条对照审查（更准），否则做通用自查
      </p>
      <div className="mt-3 space-y-2">
        {fileBtn("选择投标文件", bidFile, () => bidRef.current?.click(), true)}
        {fileBtn("选择招标文件", tenderFile, () => tenderRef.current?.click(), false)}
        <input ref={bidRef} type="file" accept=".doc,.docx,.pdf" className="hidden" onChange={(e) => setBidFile(e.target.files?.[0] ?? null)} />
        <input ref={tenderRef} type="file" accept=".doc,.docx,.pdf,.xls,.xlsx" className="hidden" onChange={(e) => setTenderFile(e.target.files?.[0] ?? null)} />
      </div>
      {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={!bidFile || busy}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl gradient-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
        {busy ? "正在上传并创建…" : tenderFile ? "创建对照审查（先读标）" : "创建审查"}
      </button>
    </section>
  )
}
