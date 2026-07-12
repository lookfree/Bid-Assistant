"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "./api-client"
import {
  clearCurrentProjectId,
  currentProjectId,
  getProject,
  peekProjectCache,
  runStep,
  stepResult,
  STEP_ORDER,
  type ChapterProgress,
  type ProjectInfo,
  type StepName,
} from "./project"

/** 步骤运行失败的用户可读文案：402 积分不足、409 步骤顺序、其余通用重试。 */
export function stepErrorMessage(status: number | null): string {
  if (status === 402) return "积分不足，无法继续本步"
  if (status === 409) return "步骤顺序不符，请先完成前序步骤"
  return "生成失败，请重试"
}

/** 各步对应的工具页入口（409 顺序错误 / 前序未完成时引导用户去补齐）。 */
const STEP_PAGE: Record<string, { href: string; label: string }> = {
  read: { href: "/read", label: "招标解读" },
  outline: { href: "/outline", label: "提纲生成" },
  content: { href: "/content", label: "标书生成" },
  review: { href: "/risk", label: "标书审查" },
  present: { href: "/present", label: "述标演示" },
}

/** step 的未完成前序步（按项目 currentStep 判断）：返回该前序步的页面入口；无前序缺口返回 null。 */
export function stepPrereq(info: ProjectInfo | null, step: StepName): { href: string; label: string } | null {
  const cur = info?.project.currentStep
  if (!cur) return null
  const curIdx = STEP_ORDER.indexOf(cur as StepName)
  if (curIdx === -1 || curIdx >= STEP_ORDER.indexOf(step)) return null
  return STEP_PAGE[cur] ?? null
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
    // 轮询专门等状态变化，必须绕过短时缓存，否则可能连续几次读到同一份陈旧快照
    const info = await getProject(projectId, { fresh: true })
    const done = stepResult<T>(info, step)
    if (done) return done
    // 无 done 行且该步不再有 running 行 → 在途那次已失败（占位行被标 failed）
    if (!info.steps.some((s) => s.step === step && s.status === "running")) throw new Error(`step ${step} 失败`)
  }
  throw new Error(`step ${step} 轮询超时`)
}

/** 步骤完成（无论正常 start() 还是收敛轮询）都可能扣了积分：广播一个全局事件，
 *  侧边栏积分卡监听后静默刷新（v1 用 window 事件，够用且不引入额外的跨组件状态管理）。 */
function notifyCreditsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("credits:refresh"))
}

// 页面级数据源 hook：真实项目在（localStorage 有 projectId）就用真实步结果，否则回退示例数据（demo）。
// data=null 且 projectId 在 → 该步还没跑：页面调 start() 触发（SSE 期间 running=true）。
export function useStep<T>(step: StepName) {
  const [projectId, setProjectId] = useState<string | null>(() => currentProjectId())
  // 挂载即刻乐观取值：同一项目若刚被别的工具页缓存过（3s 内），直接从缓存派生初值，
  // 这样该步已在服务端 running 时首帧就是「生成中」，不会先闪一下空态再切换——
  // 命中与否不影响正确性，下面的 effect 仍会发起一次 getProject 校准真实状态。
  const [info, setInfo] = useState<ProjectInfo | null>(() => {
    const id = currentProjectId()
    return id ? peekProjectCache(id) : null
  })
  const [data, setData] = useState<T | null>(() => stepResult<T>(info, step))
  const [running, setRunning] = useState(() => !!info?.steps.some((s) => s.step === step && s.status === "running"))
  const [error, setError] = useState<string | null>(null)
  // 正文逐章进度（content 步 SSE 实时；其余步为 null）。切页/刷新走轮询无法重连 SSE，故只在本次 start() 期间有值。
  const [progress, setProgress] = useState<ChapterProgress | null>(null)
  // 最近一次 start() 失败的 HTTP 状态码（402 积分不足 / 409 步骤顺序…），非 ApiError 为 null
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  // 防重（同步守卫）：running 是异步 state，双调用（自动触发 effect 重跑/双击）间隙读到的都是 false，
  // 用 ref 挡住所有页面的步骤请求双发——已有一次在途就直接忽略。
  const inFlight = useRef(false)

  useEffect(() => {
    if (!projectId) return
    let alive = true
    getProject(projectId)
      .then((i) => {
        if (!alive) return
        setInfo(i)
        const result = stepResult<T>(i, step)
        setData(result)
        // 断点续看：该步在服务端已是 running（导航离开生成页再切回来，或跨设备重新打开）——
        // 没有 done 行但也没失败，说明上次触发的 run 仍在跑。这里没有重新接 SSE 的通道
        // （v1 限制，实时重连留作后续增强），改成收敛轮询：等它跑完再把结果灌回页面。
        const row = i.steps.find((s) => s.step === step)
        if (!result && row?.status === "running") {
          setRunning(true)
          pollStepResult<T>(projectId, step)
            .then((r) => {
              if (!alive) return
              setData(r)
              notifyCreditsChanged()
            })
            .catch(() => {
              if (alive) setError(stepErrorMessage(null))
            })
            .finally(() => {
              if (alive) setRunning(false)
            })
        } else if (!result && row?.status === "failed") {
          // 上次生成失败（可能在别的页/刷新前跑挂）——明确报错让用户重试，不要静默回到空态
          // （否则表现为「进度没了」：既无进度、无结果、也无失败提示）。
          setError(stepErrorMessage(null))
        }
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
    return () => {
      alive = false
    }
  }, [projectId, step])

  // body 为该步运行参数（present 步透传 duration/template）；返回该步结果便于调用方即时使用（失败为 null）。
  const start = useCallback(
    async (body?: Record<string, unknown>): Promise<T | null> => {
      if (!projectId || inFlight.current || running) return null
      inFlight.current = true
      setRunning(true)
      setError(null)
      setProgress(null)
      setErrorStatus(null)
      try {
        const result = await runStep<T>(projectId, step, undefined, body, (p) => setProgress(p))
        setData(result)
        notifyCreditsChanged()
        return result
      } catch (e) {
        // 409 step_already_running 不是错误：本步已有一次在途 run（双发/上次连接断但 run 仍在跑），
        // 转入轮询等它收敛，别把「正在生成」误报成失败。
        if (e instanceof ApiError && e.status === 409 && e.code === "step_already_running") {
          try {
            const result = await pollStepResult<T>(projectId, step)
            setData(result)
            notifyCreditsChanged()
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

  // 失败文案与引导动作精确化：409 顺序错误 → 点名未完成的前序步并给入口；402 → 引导充值
  const prereq = errorStatus === 409 ? stepPrereq(info, step) : null
  const displayError = error && prereq ? `请先完成前序步骤：${prereq.label}` : error
  const errorAction: { href: string; label: string } | null =
    errorStatus === 402
      ? { href: "/membership", label: "去充值" }
      : prereq
        ? { href: prereq.href, label: `前往${prereq.label}` }
        : null

  return { projectId, info, data, running, progress, error: displayError, errorStatus, errorAction, start }
}
