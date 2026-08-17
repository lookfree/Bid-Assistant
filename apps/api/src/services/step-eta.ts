/** 各步预估总时长（2026-08-17 用户要求：进度条要覆盖整步，并给出预估总时间）。
 *
 *  为什么必须带规模因子：230 实测同一步的 P90 是中位数的 4~7 倍（读标中位 262s、P90 1716s；
 *  正文中位 1605s、P90 5343s）——差别几乎全来自**标书规模**（1MB 的 .doc 要转换+OCR、
 *  20 章 5 万字的正文要跑几十轮模型）。只报一个中位数，大标书用户会觉得被骗。
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"

import { getDb } from "../db/client"
import { bidProjects, projectSteps } from "../db/schema/bid-projects"
import { projectFiles } from "../db/schema/project-files"

export type StepEta = {
  /** 预估总时长（秒） */
  seconds: number
  /** 依据：history=有同步骤历史样本；default=样本不足，用实测常数兜底 */
  basis: "history" | "default"
  /** 参与中位数计算的历史样本数（前端可据此决定措辞的确定性） */
  samples: number
}

/** 样本不足时的兜底（230 生产实测中位数，2026-08-17 取样）。 */
const FALLBACK_SECONDS: Record<string, number> = {
  read: 260,
  outline: 260,
  content: 1600,
  review: 200,
  present: 160,
  export: 450,
}

/** 中位数取样条数：太少会被一两次异常轮（端点抖动重试）带偏，太多又反映不了近期表现。 */
const SAMPLE_LIMIT = 20
const MIN_SAMPLES = 3
/** 低于此秒数的行不算「跑过一次」：提纲沿用是零模型秒回、却同样记一条 done 的 outline 步
 *  （评审 2026-08-17）——它们一多就把中位数拉到地板，用户看到「预计 30 秒」然后等 5 分钟。
 *  缓存命中的读标/提纲同理。真生成没有 20 秒能跑完的。 */
const MIN_REAL_SECONDS = 20

/** 规模基准：以此为 1.0 倍。招标文件 1MB / 正文目标 4 万字 = 我们实测里的“中等偏大”。 */
const BASE_TENDER_BYTES = 1_000_000
const BASE_TARGET_CHARS = 40_000
/** 因子夹紧：再大的标书也不给出「预计 3 小时」这种让人直接放弃的数字，再小也别短到不可信。 */
const MIN_FACTOR = 0.5
const MAX_FACTOR = 3

const clamp = (x: number) => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, x))

/** 历史中位耗时（秒）：只取该步 done 且有 finished_at 的最近若干条。
 *  finished_at 是 2026-08-17 才加的列，之前的行全是 null——样本攒够之前一律走兜底常数。 */
async function historyMedian(step: string, userId?: string): Promise<{ seconds: number | null; samples: number }> {
  // 优先用**这个用户自己的**历史：他常投的标书规模才代表他的等待时间（评审 F8 顺带治了
  // 测试依赖全局行的脆弱：本用户的样本不受别的测试写入影响）。不够再退全局。
  const scoped = userId
    ? and(eq(projectSteps.step, step), eq(projectSteps.status, "done"), isNotNull(projectSteps.finishedAt),
          eq(bidProjects.userId, userId))
    : and(eq(projectSteps.step, step), eq(projectSteps.status, "done"), isNotNull(projectSteps.finishedAt))
  const rows = await getDb()
    .select({
      secs: sql<number>`extract(epoch from (${projectSteps.finishedAt} - ${projectSteps.createdAt}))`,
    })
    .from(projectSteps)
    .innerJoin(bidProjects, eq(bidProjects.id, projectSteps.projectId))
    .where(scoped)
    .orderBy(desc(projectSteps.finishedAt))
    .limit(SAMPLE_LIMIT)
  // 异常样本剔除：≤0（时钟回拨/数据异常）与 >2h（用户中途睡着不算这一步的真实耗时——
  // 半途失败重试的行也可能落到这里）都不参与中位数。
  const vals = rows.map((r) => Number(r.secs))
    .filter((v) => v >= MIN_REAL_SECONDS && v < 7200)   // 秒回的沿用/缓存命中不算真跑过
    .sort((a, b) => a - b)
  if (vals.length < MIN_SAMPLES) return { seconds: null, samples: vals.length }
  const mid = Math.floor(vals.length / 2)
  const med = vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2
  return { seconds: med, samples: vals.length }
}

/** 本项目的规模因子：读标/提纲看招标文件体量，正文看目标字数（用户自己选的那个数）。 */
async function scaleFactor(projectId: string, step: string, targetChars?: number): Promise<number> {
  if (step === "content") return clamp((targetChars || BASE_TARGET_CHARS) / BASE_TARGET_CHARS)
  const [p] = await getDb()
    .select({ tenderFileKey: bidProjects.tenderFileKey, tenderFileKeys: bidProjects.tenderFileKeys })
    .from(bidProjects)
    .where(eq(bidProjects.id, projectId))
  if (!p) return 1
  const keys = p.tenderFileKeys?.length ? p.tenderFileKeys : p.tenderFileKey ? [p.tenderFileKey] : []
  if (!keys.length) return 1
  const files = await getDb()
    .select({ size: projectFiles.size, filename: projectFiles.filename })
    .from(projectFiles)
    .where(inArray(projectFiles.key, keys))
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0)
  // .doc 要先过 LibreOffice 转换、扫描页还要 OCR——同样字节数比 .docx 慢得多（实测同一份
  // 云上江西 .doc 与 .docx 的读标耗时不在一个量级）。
  const legacy = files.some((f) => f.filename.toLowerCase().endsWith(".doc")) ? 1.6 : 1
  return clamp(((bytes || BASE_TENDER_BYTES) / BASE_TENDER_BYTES) * legacy)
}

/** 该步预估总时长。历史样本够就用历史中位数，否则用实测常数；两者都乘规模因子。 */
export async function stepEta(
  projectId: string,
  step: string,
  targetChars?: number,
  userId?: string,
): Promise<StepEta> {
  let [{ seconds: med, samples }, factor] = await Promise.all([
    historyMedian(step, userId),
    scaleFactor(projectId, step, targetChars),
  ])
  if (med == null && userId) ({ seconds: med, samples } = await historyMedian(step))  // 退全局
  const base = med ?? FALLBACK_SECONDS[step] ?? 300
  return {
    seconds: Math.max(30, Math.round((base * factor) / 10) * 10),
    basis: med ? "history" : "default",
    samples,
  }
}
