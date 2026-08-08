"use client"

/** 对照审查一键跑：解读招标文件 → （多包件时选包）→ 逐条比对，全程留在本页。
 *
 *  改之前：上传完两份文件直接 `location.href = "/read"`，用户被丢到招标解读页，等它跑完再自己
 *  回废标风险审查点生成。用户反馈"不需要跳转到招标解读，直接根据投标文件和招标文件生成对照审查"。
 *
 *  读标这一步**不能省，只能藏起来**：对照审查要拿招标文件的要求清单去比对投标文件，那份清单
 *  正是读标产出的；没有它，审查会退化成自查模式（只查标书自身，不做招标条款对照）。
 *
 *  选包是**唯一无法藏掉的一次停顿**：多包件招标不选包，就会拿所有包的★要求去比对单包的投标
 *  文件，别的包的要求全被误报成「未响应」。线上 53 个读过标的项目里 21 个是多包件（39%），
 *  按边缘情况处理会伤到四成用户。所以把选包卡搬到本页，选完接着跑，仍然不跳转。
 */
import { useState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"

import { ApiError } from "@/lib/api-client"
import type { PackageInfo } from "@/lib/bid-types"
import { PackageSelector } from "@/components/tool/package-selector"
import { nextContrastPhase } from "@/lib/contrast-flow"
import { fetchStepResult, invalidateProjectCache, runStep, setProjectPackage } from "@/lib/project"
import { stepErrorMessage } from "@/lib/use-step"

type Phase = "idle" | "reading" | "picking" | "reviewing"

const PHASE_TEXT: Record<Exclude<Phase, "idle" | "picking">, string> = {
  reading: "正在解读招标文件，提取评分办法与废标红线…（约 2–5 分钟）",
  reviewing: "正在逐条比对招标要求与投标文件…（约 1–2 分钟）",
}

export function ContrastReviewCta({
  projectId,
  projectName,
  readCost,
  reviewCost,
  onDone,
}: {
  projectId: string
  projectName: string
  readCost: number
  reviewCost: number
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  /** 读标结果里的包件；>1 时必须由人选。 */
  async function readPackages(): Promise<PackageInfo[]> {
    const read = await fetchStepResult<{ packages?: PackageInfo[] }>(projectId, "read")
    return read?.packages ?? []
  }

  async function runReview() {
    setPhase("reviewing")
    await runStep(projectId, "review")
    invalidateProjectCache(projectId)
    onDone()
  }

  async function start() {
    if (phase !== "idle") return
    setError("")
    try {
      setPhase("reading")
      await runStep(projectId, "read")
      invalidateProjectCache(projectId)
      const pkgs = await readPackages()
      if (nextContrastPhase(pkgs.length) === "pick") {
        // 唯一的停顿：选包只能由人来做，选错等于拿别的包的要求判本包的标书
        setPackages(pkgs)
        setPhase("picking")
        return
      }
      await runReview()
    } catch (e) {
      setPhase("idle")
      setError(e instanceof ApiError ? stepErrorMessage(e.status) : "生成失败，请重试")
    }
  }

  async function pick(pkg: PackageInfo) {
    if (saving) return
    setSaving(true)
    setError("")
    try {
      await setProjectPackage(projectId, { id: pkg.id, name: pkg.name })
      await runReview()
    } catch (e) {
      setPhase("picking")
      setError(e instanceof ApiError ? stepErrorMessage(e.status) : "选择包件失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  if (phase === "picking") {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 text-sm text-foreground">
          本项目为多包件招标，请选择本次投标的包件——不选的话会拿其它包件的要求来判本包的标书，
          报出一堆并不存在的风险。
        </p>
        <PackageSelector
          packages={packages}
          takenIds={[]}
          cloneCandidates={[]}
          selectedId={null}
          saving={saving}
          message={null}
          error={error || null}
          onSelect={(pkg) => void pick(pkg)}
          onClone={() => {}}
          cloning={false}
          cloneError={null}
        />
      </div>
    )
  }

  if (phase !== "idle") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-5 py-6 text-sm font-medium text-primary">
        <Loader2 className="size-4 animate-spin" />
        {PHASE_TEXT[phase]}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-primary/20 gradient-brand-soft px-5 py-4">
      <p className="text-sm font-semibold text-foreground">对照审查「{projectName}」</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        直接拿已上传的招标文件与投标文件逐条比对，生成健康分、风险项与整改建议，无需先去招标解读
      </p>
      {error && <p className="mt-2 text-xs font-medium text-destructive">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void start()}
          className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          <ShieldCheck className="size-4" />
          开始对照审查
        </button>
        {/* 费用**逐项写清**：这一步内部含招标文件解读，只写 60 会让用户对不上账 */}
        <span className="text-xs text-muted-foreground">
          消耗 {readCost + reviewCost} 积分（含招标文件解读 {readCost} + 废标体检 {reviewCost}）
        </span>
      </div>
    </div>
  )
}
