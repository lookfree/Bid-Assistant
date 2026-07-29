"use client"

import { useRef, useState } from "react"
import { Brain, EyeOff, Flame, FolderOpen, Loader2, Lock, Upload, Zap } from "lucide-react"
import { createReviewProject, setCurrentProjectId } from "@/lib/project"
import { uploadFile, uploadErrorMessage, uploadHint, ACCEPT_BID, ACCEPT_TENDER } from "@/lib/files"

/** 废标风险审查的默认入口：招标文件 + 投标文件双上传区（用户指定的版式）。
 *  两个都没传时按钮禁用；只传投标文件也放行（做通用自查，是既有能力，不因版式改动而丢）。
 *  隐私文案按**实际实现**写（加密传输存储 / 仅本人可见 / 模型不训练 / 可阅后即焚）——
 *  文件确实会传到服务端解析，不能照抄「浏览器本地存储、不上传服务器」那种做不到的承诺。 */
export function RejectUploadPanel({ onPickExisting }: { onPickExisting: () => void }) {
  const [tender, setTender] = useState<File | null>(null)
  const [bid, setBid] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!bid || busy) return
    setBusy(true)
    setError(null)
    try {
      const [bidUp, tenderUp] = await Promise.all([uploadFile(bid), tender ? uploadFile(tender) : null])
      const id = await createReviewProject(bidUp.key, tenderUp?.key)
      setCurrentProjectId(id)
      // 附了招标文件先去读标（读完自动接续审查步），否则直接进本项目的审查
      window.location.href = tenderUp ? "/read" : "/risk?view=project"
    } catch (e) {
      setError(uploadErrorMessage(e, "创建失败，请重试"))
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Zap className="size-4 text-primary" />
        标准版 <span className="font-normal text-muted-foreground">· 快速便捷</span>
      </h3>
      <p className="mt-1.5 text-sm text-muted-foreground">上传完整招标文件与投标文件，AI 将自动识别废标风险与潜在问题</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <DropZone
          label="招标文件"
          en="Tender Doc"
          hint="招标正文、补遗澄清、答疑文件等（不传则做通用自查，不逐条对照）"
          accept={ACCEPT_TENDER}
          file={tender}
          onPick={setTender}
          primary
        />
        <DropZone
          label="投标文件"
          en="Bid Doc"
          hint="需要进行合规审查的投标文件（必选）"
          accept={ACCEPT_BID}
          file={bid}
          onPick={setBid}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-around gap-3 rounded-xl bg-secondary/50 px-4 py-2.5">
        {[
          { icon: Lock, label: "全程加密传输与存储" },
          { icon: EyeOff, label: "仅本人可见" },
          { icon: Brain, label: "模型不训练" },
          { icon: Flame, label: "可阅后即焚" },
        ].map(({ icon: Icon, label }) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="size-3.5 text-primary" />
            {label}
          </span>
        ))}
      </div>

      {error && <p className="mt-3 text-xs font-medium text-destructive">{error}</p>}

      <button
        onClick={() => void submit()}
        disabled={!bid || busy}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground enabled:gradient-brand enabled:text-white enabled:hover:opacity-90"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? "正在上传并创建…" : !bid ? "请先上传招标文件与投标文件" : tender ? "创建对照审查（先读标）" : "创建通用自查（未附招标文件）"}
      </button>

      <button
        onClick={onPickExisting}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <FolderOpen className="size-3.5" />
        从我的标书选择（已生成正文的项目可直接审查，无需重传）
      </button>
    </div>
  )
}

/** 单个拖拽区：点击打开或拖拽落入；选中后显示文件名与「重新选择」。 */
function DropZone({
  label,
  en,
  hint,
  accept,
  file,
  onPick,
  primary,
}: {
  label: string
  en: string
  hint: string
  accept: string
  file: File | null
  onPick: (f: File | null) => void
  primary?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onPick(e.dataTransfer.files?.[0] ?? null) }}
      className={`cursor-pointer rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
        over || file ? "border-primary/50 bg-primary/[0.03]" : "border-border hover:border-primary/40"
      }`}
    >
      <span
        className={`mx-auto flex size-12 items-center justify-center rounded-xl ${primary ? "gradient-brand-soft" : "bg-secondary"}`}
      >
        <Upload className={`size-5 ${primary ? "text-primary" : "text-muted-foreground"}`} />
      </span>
      <p className="mt-3 text-sm font-semibold text-foreground">
        {label} <span className="font-normal text-muted-foreground">({en})</span>
      </p>
      {file ? (
        <p className="mt-1.5 truncate text-xs font-medium text-primary" title={file.name}>
          {file.name} · 点击重新选择
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-primary">点击打开</span> 或拖拽文件至此
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{uploadHint(accept)}</p>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = "" /* 允许重选同名文件 */ }}
      />
    </div>
  )
}
