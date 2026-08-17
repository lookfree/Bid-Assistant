import type { ProjectInfo, StepName } from "./project"

/** 该步的真实起步时刻（毫秒）。取 running 那条占位行的 createdAt——它就是 run 起步时刻。
 *
 *  为什么不能用「页面挂载时刻」：刷新、切页回来、断线重连都会重新挂载，而 run 还在服务端
 *  跑着；按挂载算会给一个已经跑了 25 分钟的 run 报「还需 27 分钟」（评审 2026-08-17 F6）。
 *  没有 running 行或没有 createdAt（老接口）→ null，调用方回落挂载时刻。 */
export function stepStartedAt(info: ProjectInfo | null, step: StepName): number | null {
  const row = info?.steps.find((s) => s.step === step && s.status === "running")
  if (!row?.createdAt) return null
  const ms = Date.parse(row.createdAt)
  return Number.isFinite(ms) ? ms : null
}
