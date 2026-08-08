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
import { needsRead, nextContrastPhase, shouldConverge } from "@/lib/contrast-flow"
import {
  StepFailedError, StreamIncompleteError,
  fetchStepResult, invalidateProjectCache, runStep, setProjectPackage,
  type StepName,
} from "@/lib/project"
import { pollStepResult, stepErrorMessage } from "@/lib/use-step"

type Phase = "idle" | "reading" | "picking" | "reviewing"

/** 失败文案：服务端给了可展示的原因就原样用。
 *  笼统的"请重试"正是 2026-08-07 那次事故的成因——一份盖章扫描件被重试 21 次，
 *  而每次重试都真金白银地重跑一遍读标。 */
function failureText(e: unknown): string {
  if (e instanceof StepFailedError && e.detail) return e.detail
  if (e instanceof ApiError) {
    if (e.code === "model_not_configured") return "系统尚未配置生成模型，请联系管理员在运营后台完成模型编排"
    if (e.code === "feature_locked") return "当前会员档位未包含该功能权益，可在会员中心升级后重试"
    return stepErrorMessage(e.status)
  }
  return "生成失败，请重试"
}

const PHASE_TEXT: Record<Exclude<Phase, "idle" | "picking">, string> = {
  reading: "正在解读招标文件，提取评分办法与废标红线…（约 2–5 分钟）",
  reviewing: "正在逐条比对招标要求与投标文件…（约 1–2 分钟）",
}

export function ContrastReviewCta({
  projectId,
  projectName,
  readCost,
  reviewCost,
  hasPackage,
  onDone,
}: {
  projectId: string
  projectName: string
  readCost: number
  reviewCost: number
  /** 项目已选定包件（取自项目详情，不是组件内存）：刷新/重进页面后仍要认得，
   *  否则多包件项目会在读标已扣费之后卡在"没有入口"的死角。 */
  hasPackage: boolean
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  /** 跑一步，并按与 useStep 同一口径收敛。

      **连接断了不等于失败**：读标要 2–5 分钟，代理/网络掐断 SSE 是常事，而 run 仍在服务端
      跑或已跑完。照直报"生成失败"会让用户对着一次**已经扣过费**的成功重试，再点还会撞
      409。所以断流与 409(already_running/already_done) 一律转轮询取结果。 */
  async function runAndSettle<T>(step: StepName): Promise<T> {
    try {
      return await runStep<T>(projectId, step)
    } catch (e) {
      const kind = e instanceof StreamIncompleteError
        ? "stream-incomplete" as const
        : e instanceof ApiError && e.status === 409 && e.code === "step_already_running"
          ? "already-running" as const
          : e instanceof ApiError && e.status === 409 && e.code === "step_already_done"
            ? "already-done" as const
            : "other" as const
      if (!shouldConverge(kind)) throw e
      return await pollStepResult<T>(projectId, step)
    } finally {
      invalidateProjectCache(projectId)
    }
  }

  /** 已经跑完的步不再重跑——重跑要么被 409 拒（out_of_order），要么再扣一次钱。 */
  async function readResult(): Promise<{ packages?: PackageInfo[] } | null> {
    return await fetchStepResult<{ packages?: PackageInfo[] }>(projectId, "read")
  }

  async function runReview() {
    setPhase("reviewing")
    await runAndSettle("review")
    onDone()
  }

  async function start() {
    if (phase !== "idle") return
    setError("")
    try {
      // 读标可能已经跑过（上一次审查失败后重来、或刷新过页面）：有结果就直接用，
      // 再跑一遍不是多花 20 积分就是被步序闸 409 拒死。
      setPhase("reading")
      let read = await readResult()
      if (needsRead(!!read)) {
        await runAndSettle("read")
        read = await readResult()
      }
      if (nextContrastPhase(read?.packages?.length ?? 0) === "pick" && !hasPackage) {
        // 唯一的停顿：选包只能由人来做，选错等于拿别的包的要求判本包的标书
        setPackages(read?.packages ?? [])
        setPhase("picking")
        return
      }
      await runReview()
    } catch (e) {
      setPhase("idle")
      setError(failureText(e))
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
      // 选包的 409 是 package_taken / package_locked，与"步骤顺序不符"毫无关系
      setError(e instanceof ApiError && e.code === "package_taken"
        ? "该包件已在其它项目生成过大纲，请选择其它包件"
        : e instanceof ApiError && e.status === 409
          ? "该包件已锁定，请选择其它包件"
          : failureText(e))
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
          purpose="review"
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
