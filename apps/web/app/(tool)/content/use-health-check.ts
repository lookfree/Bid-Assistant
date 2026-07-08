"use client"

import { useState } from "react"
import { type RealRisk } from "@/lib/risk-derive"
import { useStep } from "@/lib/use-step"

/**
 * 废标体检：跑真实 review 步（与 /risk 页同一步、同一份结果）。
 * 计费步：只由用户显式点击（并经计费确认弹层）触发。content 步未完成时不可体检（canCheck=false）。
 */
export function useHealthCheck(contentReady: boolean) {
  const review = useStep<RealRisk>("review")
  const [checkState, setCheckState] = useState<"idle" | "checking" | "done">("idle")

  // 体检结果：review 步结果（未跑过为 null）
  const findings: RealRisk | null = review.data
  const canCheck = contentReady

  /** 执行体检：已有结果直接进 done；否则真跑 review 步。返回体检结果（失败 null）。 */
  async function runCheck(): Promise<RealRisk | null> {
    if (!canCheck || checkState === "checking") return null
    if (review.data) {
      setCheckState("done")
      return review.data
    }
    setCheckState("checking")
    const result = await review.start()
    setCheckState(result ? "done" : "idle")
    return result
  }

  // checkErrorStatus：402 积分不足 / 409 步骤顺序（错误码直通，供页面引导充值等）
  return { checkState, findings, canCheck, runCheck, checkError: review.error, checkErrorStatus: review.errorStatus }
}
