"use client"

import { useEffect, useRef, useState } from "react"

import { overallPct, stepEta, type StepName, type StepPhase } from "./project"

/** 一段进度：本阶段在整步里的百分比区间 + 段内真实完成度（没有就 null，交给时间插值）。 */
type Seg = { base: number; ceil: number; exact: number | null }

/** 整步进度（2026-08-17 用户口径：100% 是整个任务的，并要给出预估总时间）。
 *
 *  四条不可破的性质，逐条都是「假进度条」最招骂的地方（评审 2026-08-17 逐条钉过）：
 *  ① **单调不回退**：阶段切换、事件回放、断线重连都可能让原始数字倒退，一律取历史最大值；
 *  ② **时间驱动的部分永不自行走满**：没有真实分母的阶段按预估时间在自己的区间内插值，
 *     封顶区间末 −1；整条最高 99%，100% 只由 running 结束来给；
 *  ③ **段内 done=0 也要动**：真实分母只决定「至少到哪」，时间插值可以在它之上继续推进
 *     ——否则解析阶段（done=0/total=N）会把条钉在段起点几分钟不动；
 *  ④ **心跳不许清空区间**：模型流心跳每几秒发一条无区间的 phase，若让它覆盖，
 *     插值失去区间依据，整条卡死在起点。区间按「最后一次带区间的事件」记住。
 */
export function useOverallProgress(
  projectId: string | null,
  step: StepName,
  running: boolean,
  phase: StepPhase | null,
  chapter?: { done: number; total: number; from?: number; to?: number } | null,
  targetChars?: number,
  /** 本步真实开始时刻（毫秒）。刷新/切回页面时必须传，否则按挂载时刻算，
   *  会告诉一个已经跑了 25 分钟的 run「还需 27 分钟」（评审 F6）。 */
  startedAtMs?: number | null,
) {
  const [eta, setEta] = useState<number | null>(null)
  const [etaLoaded, setEtaLoaded] = useState(false)
  const [pct, setPct] = useState(0)
  const fallbackStart = useRef<number | null>(null)
  const lastSeg = useRef<Seg | null>(null)
  const maxPct = useRef(0)

  useEffect(() => {
    if (!projectId || !running) return
    let alive = true
    setEtaLoaded(false)
    stepEta(projectId, step, targetChars)
      .then((e) => alive && setEta(e.seconds))
      .catch(() => alive && setEta(null))
      .finally(() => alive && setEtaLoaded(true))
    return () => {
      alive = false
    }
  }, [projectId, step, running, targetChars])

  useEffect(() => {
    if (running) {
      if (fallbackStart.current == null) fallbackStart.current = Date.now()
    } else {
      fallbackStart.current = null
      lastSeg.current = null
      maxPct.current = 0
      setPct(0)
    }
  }, [running])

  useEffect(() => {
    if (!running) return
    const tick = () => {
      // 章级事件自带区间且有真实分母；phase 区间只在**带区间**时更新（心跳不清空，性质④）
      const chapSeg: Seg | null =
        chapter && chapter.total > 0 && chapter.from != null && chapter.to != null
          ? {
              base: chapter.from,
              ceil: chapter.to,
              exact: chapter.from + (chapter.to - chapter.from) * Math.min(1, chapter.done / chapter.total),
            }
          : null
      const phaseSeg = overallPct(phase)
      if (phaseSeg) lastSeg.current = phaseSeg
      // 当前段 = 起点更靠后的那个：收尾段(92-100)一到，就不再听已经跑完的章级事件（性质②/评审 F4）
      const cur =
        chapSeg && (!lastSeg.current || chapSeg.base >= lastSeg.current.base) ? chapSeg : lastSeg.current
      if (cur) {
        const start = startedAtMs ?? fallbackStart.current ?? Date.now()
        const elapsed = (Date.now() - start) / 1000
        const ratio = Math.max(0, Math.min(1, elapsed / (eta ?? 300)))
        // 真实分母给下限，时间插值在其上继续推进，封顶区间末 −1（性质③）
        const timed = Math.min(cur.ceil - 1, cur.base + (cur.ceil - cur.base) * ratio)
        maxPct.current = Math.min(99, Math.max(maxPct.current, cur.exact ?? cur.base, timed))
        setPct(Math.round(maxPct.current))
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [running, phase, chapter, eta, startedAtMs])

  const start = startedAtMs ?? fallbackStart.current
  const elapsed = start ? Math.floor((Date.now() - start) / 1000) : 0
  const remain = eta != null ? eta - elapsed : null
  return {
    pct: running ? pct : 0,
    etaSeconds: eta,
    /** ETA 是否已经问过服务端（不管成没成）。没问到之前不许说「即将完成」（评审 F5）。 */
    etaLoaded,
    /** 「预计还需 X 秒」；null=估不准或已超出预估，由调用方决定怎么说 */
    remainSeconds: remain != null && remain > 0 ? remain : null,
  }
}
