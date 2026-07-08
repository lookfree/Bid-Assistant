"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { api } from "@/lib/api"
import { ApiError } from "@/lib/api-client"
import { createProject } from "@/lib/project"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import {
  UploadCloud,
  FileText,
  X,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  Loader2,
  FileCheck2,
  FolderOpen,
  Plus,
  Lock,
  EyeOff,
  Brain,
  Flame,
  PlayCircle,
  RotateCcw,
} from "lucide-react"

// 演示视频入口：未配置链接时整个隐藏（视频上线后配置 env 才显示）
const DEMO_VIDEO_URL = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL

type FileStatus = "uploading" | "done" | "error"

type UploadFile = {
  id: string
  name: string
  size: number
  progress: number
  status: FileStatus
  fileId?: string
  fileKey?: string // MinIO key（complete 返回），建项目用
  errorText?: string // 失败原因（网络/格式/超限分开），列表行展示
  file?: File // 原始 File：失败后单文件「重试」重传用（格式拦截项不存，重试无意义）
}

// 与后端 presign 白名单一致（解析层只支持这三种；.doc/.xls 老格式必须先另存为新格式）
const SUPPORTED_EXTS = new Set(["pdf", "docx", "xlsx"])

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

// 直传 PUT 到 MinIO（预签名 URL），用 XHR 拿真实上传进度。
// 失败原因区分：网络断连 → Error("network")；HTTP 非 2xx → Error("put_<status>")。
function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`put_${xhr.status}`)))
    xhr.onerror = () => reject(new Error("network"))
    xhr.send(file)
  })
}

/** 上传失败的用户可读原因（网络 / 格式 / 超限分开），决定文件行提示文案。 */
function uploadErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "file_too_large") return "文件超过大小限制（单文件最大 50MB）"
    if (e.code === "unsupported_file_type") return "文件格式不支持，仅支持 PDF / DOCX / XLSX"
    return "上传服务异常，请点击重试"
  }
  if (e instanceof Error && e.message === "network") return "网络异常，请检查网络后点击重试"
  return "上传失败，请点击重试"
}

export default function UploadPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [files, setFiles] = useState<UploadFile[]>([])
  /* 读标计费口径（优先后端实时配置），上传按钮上明示「那一下点击」将花多少积分 */
  const { overview } = useMembership()
  const readCost = creditCostValue(overview, "read", 20)

  // 三段直传：presign（建元数据+签 URL）→ 浏览器 PUT 直传 MinIO → complete（HEAD 校验落 uploaded）。
  // 失败自动重试 1 次（间隔 2s，网络抖动自愈）；仍失败落具体原因，文件行可单独「重试」。
  async function startUpload(id: string, file: File, attempt = 0): Promise<void> {
    const patch = (u: Partial<UploadFile>) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...u } : f)))
    try {
      const { fileId, uploadUrl } = await api.request<{ fileId: string; uploadUrl: string }>("/files/presign-upload", {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        }),
      })
      await putWithProgress(uploadUrl, file, (pct) => patch({ progress: pct }))
      const { file: rec } = await api.request<{ file: { key: string } }>(`/files/${fileId}/complete`, {
        method: "POST",
      })
      patch({ progress: 100, status: "done", fileId, fileKey: rec.key })
    } catch (e) {
      if (attempt === 0) {
        patch({ progress: 0 })
        await new Promise((r) => setTimeout(r, 2000))
        return startUpload(id, file, 1)
      }
      patch({ status: "error", errorText: uploadErrorText(e) })
    }
  }

  /** 单文件重传（不必移除重加）：复用原始 File 重走三段直传。 */
  function retryUpload(f: UploadFile) {
    if (!f.file) return
    setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: "uploading", progress: 0, errorText: undefined } : x)))
    void startUpload(f.id, f.file)
  }

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    for (const file of Array.from(fileList)) {
      const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      // 前置格式拦截：老格式 .doc/.xls 解析必败，别等上传/读标才失败
      const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
      if (!SUPPORTED_EXTS.has(ext)) {
        setFiles((prev) => [
          ...prev,
          {
            id, name: file.name, size: file.size, progress: 0, status: "error",
            errorText: ext === "doc" || ext === "xls" ? "不支持老版 Office 格式，请用 Word/WPS 另存为 .docx / .xlsx 后重传" : "仅支持 PDF / DOCX / XLSX",
          },
        ])
        continue
      }
      setFiles((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0, status: "uploading", file }])
      void startUpload(id, file)
    }
    if (inputRef.current) inputRef.current.value = ""
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const [creating, setCreating] = useState(false)

  // 建项目（一本标书一个 thread）→ 进入读标；后续各页经 localStorage 的 projectId 贯穿。
  // ?autostart=1：本按钮已标注读标费用，这一下点击即计费授权，read 页据此自动跑一次读标。
  async function startRead() {
    const key = files.find((f) => f.status === "done")?.fileKey
    if (!key || creating) return
    setCreating(true)
    try {
      await createProject(key)
      router.push("/read?autostart=1")
    } finally {
      setCreating(false)
    }
  }

  const securityPromises = [
    { icon: Lock, label: "全程加密传输与存储" },
    { icon: EyeOff, label: "仅本人可见" },
    { icon: Brain, label: "模型不训练" },
    { icon: Flame, label: "可阅后即焚" },
  ]

  const hasFiles = files.length > 0
  const allDone = hasFiles && files.every((f) => f.status === "done")
  const doneCount = files.filter((f) => f.status === "done").length

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      {/* 页头 */}
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">新建标书</h1>
        <p className="mt-2 text-sm text-muted-foreground">上传招标文件，AI 自动读标并生成对齐评分点的完整标书</p>
      </div>

      {/* 数据安全承诺条带（第一屏显眼处） */}
      <div className="mt-5 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-primary">
          <ShieldCheck className="size-4" />
          数据安全承诺
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {securityPromises.map((p) => (
            <div key={p.label} className="flex items-center gap-1.5">
              <p.icon className="size-4 shrink-0 text-primary" />
              <span className="text-xs font-medium text-foreground">{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 上传区 */}
      <section className="mt-5 rounded-3xl border border-border bg-card p-5 sm:p-6">
        {!hasFiles ? (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleFiles(e.dataTransfer.files)
            }}
            className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors sm:py-12 ${
              dragging ? "border-primary bg-primary/5" : "border-border bg-background"
            }`}
          >
            <span className="flex size-16 items-center justify-center rounded-2xl gradient-brand-soft">
              <UploadCloud className="size-8 text-primary" />
            </span>
            <p className="mt-5 text-lg font-semibold text-foreground">上传【招标文件】</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              支持 DOCX、PDF、XLSX 格式，单文件最大 50MB，可一次选择多个文件
            </p>

            <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl gradient-brand px-7 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <UploadCloud className="size-4" />
                点击上传招标文件
              </button>
              <button
                type="button"
                onClick={() => router.push("/projects")}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-7 py-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <FolderOpen className="size-4" />
                从我的标书选择
              </button>
            </div>

            {/* 演示视频入口（未配置链接时隐藏） */}
            {DEMO_VIDEO_URL && (
              <div className="mt-6 flex flex-col items-center gap-2 border-t border-dashed border-border pt-6">
                <p className="text-xs text-muted-foreground">想先了解产品？</p>
                <button
                  type="button"
                  onClick={() => window.open(DEMO_VIDEO_URL, "_blank")}
                  className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-card px-5 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/5"
                >
                  <PlayCircle className="size-4" />
                  观看演示视频
                </button>
                <p className="text-[11px] text-muted-foreground">3 分钟看完读标→提纲→生成→审查→述标全流程</p>
              </div>
            )}
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleFiles(e.dataTransfer.files)
            }}
            className={`rounded-2xl border bg-background p-4 transition-colors sm:p-5 ${
              dragging ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                已选择 {files.length} 个文件
                {!allDone && <span className="ml-1 font-normal text-muted-foreground">· 上传中 {doneCount}/{files.length}</span>}
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <Plus className="size-3.5" />
                继续添加
              </button>
            </div>

            <ul className="mt-4 flex flex-col gap-2.5">
              {files.map((f) => (
                <li key={f.id} className="rounded-xl border border-border bg-card p-3.5">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
                        f.status === "done"
                          ? "bg-success/10 text-success"
                          : f.status === "error"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-primary/10 text-primary"
                      }`}
                    >
                      {f.status === "done" ? <FileCheck2 className="size-5" /> : <FileText className="size-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatSize(f.size)}
                        {f.status === "done" ? (
                          <span className="ml-1.5 text-success">· 已就绪</span>
                        ) : f.status === "error" ? (
                          <span className="ml-1.5 text-destructive">· {f.errorText ?? "上传失败，请点击重试"}</span>
                        ) : (
                          <span className="ml-1.5">· 上传中 {f.progress}%</span>
                        )}
                      </p>
                    </div>
                    {f.status === "uploading" ? (
                      <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        {/* 失败可单文件重传，不必移除重加（格式拦截项无原始 File，不给重试） */}
                        {f.status === "error" && f.file && (
                          <button
                            onClick={() => retryUpload(f)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                            aria-label={`重试上传 ${f.name}`}
                          >
                            <RotateCcw className="size-3.5" />
                            重试
                          </button>
                        )}
                        <button
                          onClick={() => removeFile(f.id)}
                          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={`移除 ${f.name}`}
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  {f.status === "uploading" && (
                    <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full gradient-brand transition-all" style={{ width: `${f.progress}%` }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <button
              disabled={!allDone || creating}
              onClick={startRead}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl gradient-brand px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? "创建项目中…" : allDone ? `开始智能读标（约 ${readCost} 积分）` : "文件上传中…"}
              {allDone && <ArrowRight className="size-4" />}
            </button>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.xlsx"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        {/* 附件说明 */}
        <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-secondary/60 px-4 py-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            除 [招标文件] 外，同时支持上传 [工程量清单]、[技术要求附件]、[历史参考方案] 等多类文件，解析更精准。
          </p>
        </div>

        {/* 提示卡片 */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">新用户免费体验：</span>
              注册赠 200 积分，可自由用于读标 / 提纲 / 生成 / 导出；积分用尽后再充值或开通会员。
            </p>
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">数据安全：</span>
              文件全程加密传输与存储，仅你本人可见。
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
