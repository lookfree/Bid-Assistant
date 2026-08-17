"use client"

import { useEffect, useRef, useState } from "react"

import { overallPct, stepEta, type StepName, type StepPhase } from "./project"

/** 整步进度（2026-08-17 用户口径：100% 是整个任务的，并要给出预估总时间）。
 *
 *  三条不可破的性质，逐条都是「假进度条」最招骂的地方：
 *  ① **单调不回退**：阶段切换、事件回放、重连都可能让原始数字倒退，一律取历史最大值；
 *  ② **时间驱动的部分永不自行走满**：没有真实分母的阶段按预估时间在自己的区间内插值，
 *     封顶在区间末 −1；100% 只由真正的完成（running 结束）来给；
 *  ③ **估不准就别硬撑**：跑过预估时间还没结束，条停在当前值不动，文案改成「即将完成」，
 *     绝不倒着走，也不假装还剩几秒。
 */
export function useOverallProgress(
  projectId: string | null,
  step: StepName,
  running: boolean,
  phase: StepPhase | null,
  chapter?: { done: number; total: number; from?: number; to?: number } | null,
  targetChars?: number,
) {
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null)
  const [pct, setPct] = useState(0)
  const startedAt = useRef<number | null>(null)
  const maxPct = useRef(0)

  // 预估总时长：本步开跑时取一次。取不到就没有 ETA（进度条仍按真实分母画，只是不显示剩余时间）。
  useEffect(() => {
    if (!projectId || !running) return
    let alive = true
    stepEta(projectId, step, targetChars)
      .then((e) => alive && setEtaSeconds(e.seconds))
      .catch(() => alive && setEtaSeconds(null))
    return () => {
      alive = false
    }
  }, [projectId, step, running, targetChars])

  // 本步一开跑就记起点；跑完清零，下一次运行重新计时（不清的话第二次跑会瞬间"超时"）。
  useEffect(() => {
    if (running) {
      if (startedAt.current == null) startedAt.current = Date.now()
    } else {
      startedAt.current = null
      maxPct.current = 0
      setPct(0)
    }
  }, [running])

  useEffect(() => {
    if (!running) return
    const tick = () => {
      const span = overallPct(phase)
      // 逐章事件自带整步区间：章级 done/total 是真实分母，优先级最高
      const chapterPct =
        chapter && chapter.total > 0 && chapter.from != null && chapter.to != null
          ? chapter.from + (chapter.to - chapter.from) * Math.min(1, chapter.done / chapter.total)
          : null
      let next = maxPct.current
      if (chapterPct != null) next = Math.max(next, chapterPct)
      else if (span?.exact != null) next = Math.max(next, span.exact)
      else if (span) {
        // 无真实分母：按预估时间在本阶段区间内插值，封顶区间末 −1（绝不替下一阶段宣布开始）
        const elapsed = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0
        const total = etaSeconds ?? 300
        const ratio = Math.max(0, Math.min(1, elapsed / total))
        next = Math.max(next, Math.min(span.ceil - 1, span.base + (span.ceil - span.base) * ratio))
      }
      maxPct.current = Math.min(99, next) // 100% 只由 running 结束来给
      setPct(Math.round(maxPct.current))
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [running, phase, chapter, etaSeconds])

  const elapsed = startedAt.current ? Math.floor((Date.now() - startedAt.current) / 1000) : 0
  const remain = etaSeconds != null ? etaSeconds - elapsed : null
  return {
    pct: running ? pct : 0,
    etaSeconds,
    /** 「预计还需 X 分钟」；跑过预估时间后给 null，由调用方显示「即将完成」而不是负数 */
    remainSeconds: remain != null && remain > 0 ? remain : null,
  }
}
