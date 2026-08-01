import type { LucideIcon } from "lucide-react"

/** 读标页的类目派生（从页面抽出，页面已过 800 行红线）。
 *  单一职责：把「权威结果 or 分轮展示态」整理成右栏要渲染的类目列表。 */
export type AnalysisLike = { title: string; value?: string; status?: string; clauseIds: string[] }
export type CategoryView<I> = { key: string; title: string; icon: LucideIcon; items: I[] }

/** 展示顺序固定：分轮是并发跑的、完成次序随机，按到达顺序排会让页面随机地开在
 *  「技术需求」（可能几千条）而不是「项目概况」。 */
const ORDER = ["overview", "qualification", "commercial", "technical", "scoring", "format"]

/** 分轮事件从 agent 直穿，是 snake_case；只转右栏要用的 clause_ids，转换面越小越不容易错。 */
export function partialToCategories<I>(partial: Record<string, unknown> | null): CategoryView<I>[] {
  const raw = (partial?.categories ?? []) as { key: string; title: string; items: Record<string, unknown>[] }[]
  return raw.map((c) => ({
    key: c.key,
    title: c.title,
    icon: undefined as unknown as LucideIcon,   // 图标由页面按 key 补，避免这里依赖图标表
    items: c.items.map((i) => ({ ...i, clauseIds: (i.clause_ids as string[]) ?? [] })) as I[],
  }))
}

/**
 * 合并去重 + 定序 + 补齐评分类目。
 *
 * 按 key 合并：模型可能对同一 key 产出多个块（如把资格拆成两段），右栏按 key 过滤渲染，
 * 重复 key 会让一次点击把多类内容全堆出来（实测「点几次就对不上号」）。
 *
 * **补齐 scoring 类目**：评分表挂在 key=scoring 下，而分段读标（>200 条款）从不产这个类目——
 * 评分轮的产出落在 result.scoring 字段，categories 只有 overview/qualification/commercial/
 * format/technical。于是大标书解读出几十条评分点，页面上一条都点不到（实测 876/2014 条款的
 * 项目 scoring 有 44/51 行，keys 里全无 scoring）。按数据补类目：有评分行就一定有入口。
 */
export function buildCategories<I>(
  src: CategoryView<I>[],
  hasScoringRows: boolean,
  iconFor: (key: string) => LucideIcon,
): CategoryView<I>[] {
  const byKey = new Map<string, CategoryView<I>>()
  for (const c of src) {
    const prev = byKey.get(c.key)
    if (prev) prev.items.push(...c.items)
    else byKey.set(c.key, { key: c.key, title: c.title, icon: iconFor(c.key), items: [...c.items] })
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => (ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99),
  )
  if (hasScoringRows && !byKey.has("scoring")) {
    const at = sorted.findIndex((c) => c.key === "format")
    const tab = { key: "scoring", title: "评分办法", icon: iconFor("scoring"), items: [] as I[] }
    sorted.splice(at < 0 ? sorted.length : at, 0, tab)
  }
  return sorted
}

/** 本次要渲染的类目：权威结果优先，跑的过程中用分轮产出兜底。
 *  权威结果一到就**整体取代**分轮产出——前端不复刻服务端的合并语义（按包过滤等），只作展示。 */
export function readCategories<I extends { clauseIds: string[] }>(
  real: { categories: { key: string; title: string; items: (Omit<I, "clauseIds"> & { clauseIds?: string[] })[] }[] } | null,
  partial: Record<string, unknown> | null,
  hasScoringRows: boolean,
  iconFor: (key: string) => LucideIcon,
): CategoryView<I>[] {
  const src = real
    ? real.categories.map((c) => ({
        key: c.key,
        title: c.title,
        icon: iconFor(c.key),
        items: c.items.map((i) => ({ ...i, clauseIds: i.clauseIds ?? [] })) as I[],
      }))
    : partialToCategories<I>(partial)
  return buildCategories<I>(src, hasScoringRows, iconFor)
}
