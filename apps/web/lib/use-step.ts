"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "./api-client"
import {
  clearCurrentProjectId,
  currentProjectId,
  getProject,
  invalidateProjectCache,
  peekProjectCache,
  runStep,
  fetchStepResult,
  STEP_ORDER,
  openStepEvents,
  StreamIncompleteError,
  type ChapterProgress,
  type StepPhase,
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

// 断连/双发后的收敛轮询节奏：每 5s 查一次项目。上限 30 分钟——content 大标书正文实测 11+ 分钟,
// 叠加降级重试可能更久;若连接早断则轮询要撑到 run 真正结束（run 仍在跑就一直等；
// running 行消失且无 done 才判失败）。服务端另有对账 Cron 兜底,超时只是放弃「本页等待」。
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 30 * 60_000

/** 该步已有一次在途 run（双发漏网/断线后重进页面）时的收敛轮询：
 *  轮询 slim 项目信息等状态变化——出现 done 行即按需拉取该步结果返回；
 *  running 行消失仍无 done（在途那次失败）或超时则抛错，由调用方转失败文案。 */
export async function pollStepResult<T>(projectId: string, step: StepName): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let doneButEmpty = 0   // done 行却拉不到结果:连续多次即终止(别空转满 20 分钟)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    // 轮询专门等状态变化，必须绕过短时缓存，否则可能连续几次读到同一份陈旧快照
    const info = await getProject(projectId, { fresh: true })
    const row = info.steps.find((s) => s.step === step)
    if (row?.status === "done") {
      // 结果拉取容错:瞬时失败(网络抖动/发版窗口 5xx)继续轮询重取——此处抛出会把
      // 已成功且已扣费的 run 误报成「生成失败」,诱导用户重跑再扣一次(评审确认项)。
      try {
        const result = await fetchStepResult<T>(projectId, step)
        if (result !== null) return result
        if (++doneButEmpty >= 3) throw new Error(`step ${step} 结果缺失`)
      } catch (e) {
        if (doneButEmpty >= 3) throw e
        /* 瞬时失败:下一轮再试 */
      }
    }
    // 无 done 行且该步不再有 running 行 → 在途那次已失败（占位行被标 failed）
    if (row?.status !== "done" && row?.status !== "running") throw new Error(`step ${step} 失败`)
  }
  throw new Error(`step ${step} 轮询超时`)
}

/** 步骤完成（无论正常 start() 还是收敛轮询）都可能扣了积分：广播一个全局事件，
 *  侧边栏积分卡监听后静默刷新（v1 用 window 事件，够用且不引入额外的跨组件状态管理）。 */
export function notifyCreditsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("credits:refresh"))
}

// 页面级数据源 hook：真实项目在（localStorage 有 projectId）就用真实步结果，否则回退示例数据（demo）。
// data=null 且 projectId 在 → 该步还没跑：页面调 start() 触发（SSE 期间 running=true）。
export function useStep<T>(step: StepName) {
  const [projectId, setProjectId] = useState<string | null>(() => currentProjectId())
  // 挂载即刻乐观取值：同一项目若刚被别的工具页缓存过（30s TTL 内），直接从缓存派生初值，
  // 这样该步已在服务端 running 时首帧就是「生成中」，不会先闪一下空态再切换——
  // 命中与否不影响正确性，下面的 effect 仍会发起一次 getProject 校准真实状态。
  const [info, setInfo] = useState<ProjectInfo | null>(() => {
    const id = currentProjectId()
    return id ? peekProjectCache(id) : null
  })
  const [data, setData] = useState<T | null>(null)
  // 本步结果按需拉取中（slim 首屏后、且服务端确认有 done 结果才为 true）——
  // 页面据此只在"真有数据在路上"时显示「正在加载XX数据…」,没数据的页面秒开不显示加载。
  const [dataLoading, setDataLoading] = useState(false)
  const [running, setRunning] = useState(() => !!info?.steps.some((s) => s.step === step && s.status === "running"))
  const [error, setError] = useState<string | null>(null)
  // 正文逐章进度（content 步实时）。下方订阅 effect 会在该步 running 时（本次生成/切回/刷新都算）
  // 重连事件流并回放，故切页/刷新回来也能接上进度，不再局限于本次 start()。
  const [progress, setProgress] = useState<ChapterProgress | null>(null)
  // 运行阶段标签（读标分段/审查等 node/phase 事件 → 人话），content 走 progress 逐章。
  const [phase, setPhase] = useState<StepPhase | null>(null)
  // 最近一次 start() 失败的 HTTP 状态码（402 积分不足 / 409 步骤顺序…），非 ApiError 为 null
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  // 最近一次 start() 失败的业务错误码（package_required 等需要专属引导动作的场景），非 ApiError 为 null
  const [errorCode, setErrorCode] = useState<string | null>(null)
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
        const row = i.steps.find((s) => s.step === step)
        // slim 首屏只有状态：该步已 done 才按需拉结果（其间 dataLoading=true，页面显示精确加载文案）；
        // 没有 done 行的页面不进入任何加载态——秒开直达引导/生成入口。
        if (row?.status === "done") {
          setRunning(false)   // peek 缓存可能带来陈旧 running=true 初值:已 done 必须复位,否则横幅永挂
          setDataLoading(true)
          fetchStepResult<T>(projectId, step)
            .then((r) => {
              if (alive) setData(r)
            })
            .catch(() => {
              if (alive) setError("加载结果失败，请刷新重试")
            })
            .finally(() => {
              if (alive) setDataLoading(false)
            })
          return
        }
        // 断点续看：该步在服务端已是 running（导航离开生成页再切回来，或跨设备重新打开）——
        // 没有 done 行但也没失败，说明上次触发的 run 仍在跑。这里靠收敛轮询等它跑完把结果灌回页面；
        // 中间进度则由下方订阅 effect（running=true 即重连事件流并回放）实时补上。
        if (row?.status === "running") {
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
        } else if (row?.status === "failed") {
          // 上次生成失败（可能在别的页/刷新前跑挂）——明确报错让用户重试，不要静默回到空态
          // （否则表现为「进度没了」：既无进度、无结果、也无失败提示）。
          setRunning(false)   // 同上:复位可能来自 peek 缓存的陈旧 running
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

  // 实时进度订阅：只要该步在服务端运行(本次生成/断点续看/刷新都算),就订阅进度事件流,
  // 页面停留、切回、刷新都能实时显示到「跑到哪一步/写完几章」。run 结束或离开即断开。
  useEffect(() => {
    if (!projectId || !running) return
    const cancel = openStepEvents(projectId, step, (e) => {
      if (e.kind === "chapter") setProgress(e.progress)
      else if (e.kind === "phase") setPhase(e.phase)
    })
    return cancel
  }, [projectId, step, running])

  // body 为该步运行参数（present 步透传 duration/template）；返回该步结果便于调用方即时使用（失败为 null）。
  const start = useCallback(
    async (body?: Record<string, unknown>): Promise<T | null> => {
      if (!projectId || inFlight.current || running) return null
      inFlight.current = true
      setRunning(true)
      setError(null)
      setProgress(null)
      setPhase(null)
      setErrorStatus(null)
      setErrorCode(null)
      // 立刻失效项目缓存：缓存快照是「点击前」抓的（无 running 行）,30s TTL 内切走再切回
      // 会命中它并渲染成「尚未生成」的空闲态 + 计费按钮——运行状态凭空消失（切页断流感）。
      invalidateProjectCache(projectId)
      try {
        const result = await runStep<T>(projectId, step, undefined, body)
        setData(result)
        notifyCreditsChanged()
        return result
      } catch (e) {
        // 连接中途断开（长步骤如 content 十多分钟被代理/网络掐断，未收到 step.done）：
        // run 仍在服务端跑/已跑完，转轮询收敛，绝不误报「生成失败」（用户实测：刷新后其实已成功）。
        // 与 409 step_already_running（双发/重进页面）同样处理。
        // step_already_done：撞上服务端对账刚把上一次成功 run 收尾交付——结果已在,收敛轮询立即取回
        const shouldPoll =
          e instanceof StreamIncompleteError ||
          (e instanceof ApiError && e.status === 409 &&
            (e.code === "step_already_running" || e.code === "step_already_done"))
        if (shouldPoll) {
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
        const code = e instanceof ApiError ? e.code : null
        setErrorStatus(status)
        setErrorCode(code ?? null)
        // 模型未配置（运营后台未编排主/降级模型）：C 端用户无法自助解决，明确提示联系管理员；
        // package_required（多包招标未选包）：硬门禁——必须回读标页选包后才能生成大纲
        setError(code === "model_not_configured"
          ? "系统尚未配置生成模型，请联系管理员在运营后台完成模型编排"
          : code === "package_required"
            ? "本项目为多包件招标，请先在「招标解读」页选择投标包件，再生成大纲"
            : stepErrorMessage(status))
        return null
      } finally {
        inFlight.current = false
        setRunning(false)
      }
    },
    [projectId, step, running],
  )

  // 失败文案与引导动作精确化：409 顺序错误 → 点名未完成的前序步并给入口；402 → 引导充值；
  // package_required → 引导回读标页选包
  const prereq = errorStatus === 409 ? stepPrereq(info, step) : null
  const displayError = error && prereq ? `请先完成前序步骤：${prereq.label}` : error
  const errorAction: { href: string; label: string } | null =
    errorStatus === 402
      ? { href: "/membership", label: "去充值" }
      : errorCode === "package_required"
        ? { href: "/read", label: "去选择包件" }
        : prereq
          ? { href: prereq.href, label: `前往${prereq.label}` }
          : null

  return { projectId, info, data, dataLoading, running, progress, phase, error: displayError, errorStatus, errorAction, start }
}

/** 跨步结果按需拉取（slim 首屏配套）：本页需要引用**其他步骤**的结果时用
 *  （提纲页的原文栏引用 read 结果、正文页的章节树引用 outline 结果）。
 *  该步无 done 行 → 不发请求、loading 恒 false（没数据的页面绝不显示加载）。 */
export function useOtherStepResult<T>(projectId: string | null, info: ProjectInfo | null, step: StepName) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  // 拉取失败 ≠ 数据不存在:调用方须区分展示（否则「提纲已完成但拉取瞬断」会被误说成"先完成提纲"）
  const [error, setError] = useState(false)
  const done = !!info?.steps.some((s) => s.step === step && s.status === "done")
  useEffect(() => {
    if (!projectId || !done) return
    let alive = true
    setLoading(true)
    setError(false)
    fetchStepResult<T>(projectId, step)
      .then((r) => {
        if (alive) setData(r)
      })
      .catch(() => {
        if (alive) setError(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId, step, done])
  return { data, loading, error }
}
