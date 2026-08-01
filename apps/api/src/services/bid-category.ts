import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { bidCategoryCorrections, projectSteps, type BidCategoryValue } from "../db/schema"

// 标书分类（spec334）的取值与纠偏记录。**有效值解析只此一处实现**——散在几处各写各的，
// 迟早出现「提纲按 A 生成、审查按 B 检查」的分叉。

/** 判定值（对外形状）。**落库是 agent 的 snake_case，出口必须转成 camel**——
 *  项目详情不走 `resultForUser`/`toCamel`（那只处理 steps[].result），
 *  原样吐出去前端读 `evidenceClauseIds` 会恒为 undefined 且没有类型报错。 */
export type DetectedCategory = {
  value: BidCategoryValue[]
  confidence?: string
  reason?: string
  evidenceClauseIds?: string[]
}

type RawDetected = { value?: unknown; confidence?: string; reason?: string; evidence_clause_ids?: string[] }

/**
 * 系统判定值：取该项目最近一次带分类的 done 步结果（生成流水线与对照审查在 read 步产出，
 * 无招标文件的自查在 review 步产出）。
 *
 * **只取 `result -> 'bid_category'` 这一个 JSON 键，绝不 SELECT 整列**：大标书 read result 可达
 * 1MB，为一个标量把它从远程 PG 拖过隧道正是首屏慢的老病根（同 `result -> 'packages'` 的门禁写法）。
 */
export async function detectedCategory(projectId: string): Promise<DetectedCategory | null> {
  const [row] = await getDb()
    .select({ cat: sql<RawDetected | null>`${projectSteps.result} -> 'bid_category'` })
    .from(projectSteps)
    .where(
      and(
        eq(projectSteps.projectId, projectId),
        inArray(projectSteps.step, ["read", "review"]),
        eq(projectSteps.status, "done"),
        sql`${projectSteps.result} -> 'bid_category' is not null`,
      ),
    )
    .orderBy(desc(projectSteps.createdAt))
    .limit(1)
  const cat = row?.cat
  if (!cat || !Array.isArray(cat.value)) return null
  return {
    value: cat.value as BidCategoryValue[],
    confidence: cat.confidence,
    reason: cat.reason,
    evidenceClauseIds: cat.evidence_clause_ids ?? [],
  }
}

/**
 * 本次生效的分类 = 用户确认值 ?? 系统判定值。
 *
 * **判定值默认生效，不等用户点**——否则绝大多数用户根本不会点那张卡，功能等于没做。
 * `confirmed` 是三态：`null` 用户没表态（回落判定值）／非空数组 用户选定／
 * **空数组 用户明确要求不用分类**。第三态不可省：判定给了个用户认为都不合适的类别时，
 * 他必须有办法关掉，否则每次重跑都被强加一次。
 */
export function effectiveCategory(
  confirmed: BidCategoryValue[] | null | undefined,
  detected: DetectedCategory | null,
): BidCategoryValue[] {
  if (Array.isArray(confirmed)) return confirmed
  return detected?.value ?? []
}

const sameCategory = (a: BidCategoryValue[], b: BidCategoryValue[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]) // 顺序有意义：首元素是主类别

/**
 * 记一条纠偏样本。**判定值为空时一律不记**——多包件、判据不足、分类调用失败三种情况判定值都是空，
 * 那时用户的任何选择都满足「与判定值不同」，全记下来会让「判错方向」的统计里混满
 * 「我们压根没判」的样本。判定值为空是**覆盖率**问题，不是**准确率**问题，两者要分开看。
 */
export async function logCategoryCorrection(
  projectId: string,
  detected: DetectedCategory | null,
  confirmed: BidCategoryValue[],
): Promise<boolean> {
  if (!detected?.value.length) return false
  if (sameCategory(detected.value, confirmed)) return false
  await getDb()
    .insert(bidCategoryCorrections)
    .values({ projectId, detected: detected.value, confirmed, confidence: detected.confidence ?? null })
  return true
}
