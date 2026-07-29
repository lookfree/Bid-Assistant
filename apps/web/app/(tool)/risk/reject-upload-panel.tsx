"use client"

import { useRef, useState } from "react"
import { Brain, EyeOff, Flame, FolderOpen, Loader2, Lock, Upload, X, Zap } from "lucide-react"
import { createReviewProject, setCurrentProjectId } from "@/lib/project"
import { uploadFile, uploadErrorMessage, uploadHint, checkFiles, ACCEPT_BID, ACCEPT_TENDER } from "@/lib/files"

/** 废标风险审查的默认入口：招标文件 + 投标文件双上传区（用户指定的版式）。
 *  **两份都必传**（用户口径：废标审查是拿招标要求逐条比对投标文件，两者是一体的，
 *  不允许单独拿投标文件做废标审查）——缺一侧按钮就禁用，避免用户只传一份也被扣掉积分。
 *  隐私文案按**实际实现**写（加密传输存储 / 仅本人可见 / 模型不训练 / 可阅后即焚）——
 *  文件确实会传到服务端解析，不能照抄「浏览器本地存储、不上传服务器」那种做不到的承诺。 */
export function RejectUploadPanel({ onPickExisting }: { onPickExisting: () => void }) {
  const [tender, setTender] = useState<File[]>([])
  const [bid, setBid] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!bid.length || !tender.length || busy) return
    setBusy(true)
    setError(null)
    try {
      // 顺序即拼接顺序（商务标在前还是技术标在前由用户的选择顺序决定），故 map 后整体并发上传
      const [bidUp, tenderUp] = await Promise.all([
        Promise.all(bid.map(uploadFile)),
        Promise.all(tender.map(uploadFile)),
      ])
      const id = await createReviewProject(bidUp.map((f) => f.key), tenderUp.map((f) => f.key))
      setCurrentProjectId(id)
      window.location.href = "/read" // 先读标，读完自动接续审查步
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
          hint="招标正文、补遗澄清、答疑文件等，可多选（必选：没有招标要求就无从判定废标）"
          accept={ACCEPT_TENDER}
          files={tender}
          onPick={setTender}
          primary
        />
        <DropZone
          label="投标文件"
          en="Bid Doc"
          hint="需要进行合规审查的投标文件，可多选（必选；商务标与技术标分册出卷时一起传）"
          accept={ACCEPT_BID}
          files={bid}
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
        disabled={!bid.length || !tender.length || busy}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground enabled:gradient-brand enabled:text-white enabled:hover:opacity-90"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy
          ? "正在上传并创建…"
          : !bid.length && !tender.length
            ? "请先上传招标文件与投标文件"
            : !tender.length
              ? "请补充招标文件"
              : !bid.length
                ? "请补充投标文件"
                : "创建对照审查（先读标）"}
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

/** 单个拖拽区：点击打开或拖拽落入，可多选并追加；已选文件逐条列出、可单独移除。 */
function DropZone({
  label,
  en,
  hint,
  accept,
  files,
  onPick,
  primary,
}: {
  label: string
  en: string
  hint: string
  accept: string
  files: File[]
  onPick: (f: File[]) => void
  primary?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [reject, setReject] = useState<string | null>(null)
  // 追加而非替换：分册标书往往分两次选（先选商务标再选技术标），替换会让用户以为第一份没传上。
  // 先做类型/大小/份数校验：拖拽绕过 accept，不在这里拦就要等全部直传完再被服务端 400。
  const add = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    if (!picked.length) return
    const bad = checkFiles(picked, accept, files.length)
    setReject(bad)
    if (!bad) onPick([...files, ...picked])
  }

  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files) }}
      className={`cursor-pointer rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
        over || files.length ? "border-primary/50 bg-primary/[0.03]" : "border-border hover:border-primary/40"
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
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1 text-left">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-lg bg-background px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={f.name}>
                {f.name}
              </span>
              <button
                type="button"
                aria-label={`移除 ${f.name}`}
                onClick={(e) => { e.stopPropagation(); onPick(files.filter((_, idx) => idx !== i)) }}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          <li className="pt-0.5 text-center text-[11px] text-primary">点击继续添加</li>
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-primary">点击打开</span> 或拖拽文件至此
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{uploadHint(accept)}</p>
      {reject && <p className="mt-1 text-[11px] font-medium text-destructive">{reject}</p>}
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => { add(e.target.files); e.target.value = "" /* 允许重选同名文件 */ }}
      />
    </div>
  )
}
