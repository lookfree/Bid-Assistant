"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "./api-client"
import { clearCurrentProjectId, currentProjectId, getProject, runStep, stepResult, type ProjectInfo, type StepName } from "./project"

/** 步骤运行失败的用户可读文案：402 积分不足、409 步骤顺序、其余通用重试。 */
export function stepErrorMessage(status: number | null): string {
  if (status === 402) return "积分不足，无法继续本步"
  if (status === 409) return "步骤顺序不符，请先完成前序步骤"
  return "生成失败，请重试"
}

// 409 step_already_running 后的收敛轮询节奏：每 5s 查一次项目，最多等 10 分钟（正常步 1-10 分钟必出结果）
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60_000

/** 该步已有一次在途 run（双发漏网/断线后重进页面）时的收敛轮询：
 *  轮询 GET /api/projects/:id 等它出结果——出现 done 行即返回 result；
 *  running 行消失仍无 done（在途那次失败）或超时则抛错，由调用方转失败文案。 */
async function pollStepResult<T>(projectId: string, step: StepName): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const info = await getProject(projectId)
    const done = stepResult<T>(info, step)
    if (done) return done
    // 无 done 行且该步不再有 running 行 → 在途那次已失败（占位行被标 failed）
    if (!info.steps.some((s) => s.step === step && s.status === "running")) throw new Error(`step ${step} 失败`)
  }
  throw new Error(`step ${step} 轮询超时`)
}

// 页面级数据源 hook：真实项目在（localStorage 有 projectId）就用真实步结果，否则回退示例数据（demo）。
// data=null 且 projectId 在 → 该步还没跑：页面调 start() 触发（SSE 期间 running=true）。
export function useStep<T>(step: StepName) {
  const [projectId, setProjectId] = useState<string | null>(() => currentProjectId())
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 最近一次 start() 失败的 HTTP 状态码（402 积分不足 / 409 步骤顺序…），非 ApiError 为 null
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  // 防重（同步守卫）：running 是异步 state，双调用（自动触发 effect 重跑/双击）间隙读到的都是 false，
  // 用 ref 挡住所有页面的步骤请求双发——已有一次在途就直接忽略。
  const inFlight = useRef(false)

  useEffect(() => {
    if (!projectId) return
    getProject(projectId)
      .then((i) => {
        setInfo(i)
        setData(stepResult<T>(i, step))
      })
      .catch((e) => {
        // 404 = 本地 projectId 指向已删项目（生产实测：删项目后所有工具页陷入「加载项目失败」死胡同）
        // → 清掉 localStorage 残留并按「无项目」处理，页面自然落 NoProjectGuide 引导；
        // 其余错误（网络/500）保持现有错误提示，可刷新重试。
        if (e instanceof ApiError && e.status === 404) {
          clearCurrentProjectId()
          setProjectId(null)
          return
        }
        setError("加载项目失败")
      })
  }, [projectId, step])

  // body 为该步运行参数（present 步透传 duration/template）；返回该步结果便于调用方即时使用（失败为 null）。
  const start = useCallback(
    async (body?: Record<string, unknown>): Promise<T | null> => {
      if (!projectId || inFlight.current || running) return null
      inFlight.current = true
      setRunning(true)
      setError(null)
      setErrorStatus(null)
      try {
        const result = await runStep<T>(projectId, step, undefined, body)
        setData(result)
        return result
      } catch (e) {
        // 409 step_already_running 不是错误：本步已有一次在途 run（双发/上次连接断但 run 仍在跑），
        // 转入轮询等它收敛，别把「正在生成」误报成失败。
        if (e instanceof ApiError && e.status === 409 && e.code === "step_already_running") {
          try {
            const result = await pollStepResult<T>(projectId, step)
            setData(result)
            return result
          } catch {
            setError(stepErrorMessage(null))
            return null
          }
        }
        // 其余错误码直通：402/409(out_of_order) 给专属文案并暴露状态码，消费端可据此引导充值 / 步骤提示
        const status = e instanceof ApiError ? e.status : null
        setErrorStatus(status)
        setError(stepErrorMessage(status))
        return null
      } finally {
        inFlight.current = false
        setRunning(false)
      }
    },
    [projectId, step, running],
  )

  return { projectId, info, data, running, error, errorStatus, start }
}
