"use client"

import { useCallback, useEffect, useState } from "react"
import { currentProjectId, getProject, runStep, stepResult, type ProjectInfo, type StepName } from "./project"

// 页面级数据源 hook：真实项目在（localStorage 有 projectId）就用真实步结果，否则回退示例数据（demo）。
// data=null 且 projectId 在 → 该步还没跑：页面调 start() 触发（SSE 期间 running=true）。
export function useStep<T>(step: StepName) {
  const [projectId] = useState<string | null>(() => currentProjectId())
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    getProject(projectId)
      .then((i) => {
        setInfo(i)
        setData(stepResult<T>(i, step))
      })
      .catch(() => setError("加载项目失败"))
  }, [projectId, step])

  const start = useCallback(async () => {
    if (!projectId || running) return
    setRunning(true)
    setError(null)
    try {
      setData(await runStep<T>(projectId, step))
    } catch {
      setError("生成失败，请重试")
    } finally {
      setRunning(false)
    }
  }, [projectId, step, running])

  return { projectId, info, data, running, error, start }
}
