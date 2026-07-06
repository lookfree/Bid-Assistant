"use client"

import { useCallback, useEffect, useState } from "react"
import { ApiError } from "./api-client"
import { currentProjectId, getProject, runStep, stepResult, type ProjectInfo, type StepName } from "./project"

/** 步骤运行失败的用户可读文案：402 积分不足、409 步骤顺序、其余通用重试。 */
export function stepErrorMessage(status: number | null): string {
  if (status === 402) return "积分不足，无法继续本步"
  if (status === 409) return "步骤顺序不符，请先完成前序步骤"
  return "生成失败，请重试"
}

// 页面级数据源 hook：真实项目在（localStorage 有 projectId）就用真实步结果，否则回退示例数据（demo）。
// data=null 且 projectId 在 → 该步还没跑：页面调 start() 触发（SSE 期间 running=true）。
export function useStep<T>(step: StepName) {
  const [projectId] = useState<string | null>(() => currentProjectId())
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 最近一次 start() 失败的 HTTP 状态码（402 积分不足 / 409 步骤顺序…），非 ApiError 为 null
  const [errorStatus, setErrorStatus] = useState<number | null>(null)

  useEffect(() => {
    if (!projectId) return
    getProject(projectId)
      .then((i) => {
        setInfo(i)
        setData(stepResult<T>(i, step))
      })
      .catch(() => setError("加载项目失败"))
  }, [projectId, step])

  // body 为该步运行参数（present 步透传 duration/template）；返回该步结果便于调用方即时使用（失败为 null）。
  const start = useCallback(
    async (body?: Record<string, unknown>): Promise<T | null> => {
      if (!projectId || running) return null
      setRunning(true)
      setError(null)
      setErrorStatus(null)
      try {
        const result = await runStep<T>(projectId, step, undefined, body)
        setData(result)
        return result
      } catch (e) {
        // 错误码直通：402/409 给专属文案并暴露状态码，消费端可据此引导充值 / 步骤提示
        const status = e instanceof ApiError ? e.status : null
        setErrorStatus(status)
        setError(stepErrorMessage(status))
        return null
      } finally {
        setRunning(false)
      }
    },
    [projectId, step, running],
  )

  return { projectId, info, data, running, error, errorStatus, start }
}
