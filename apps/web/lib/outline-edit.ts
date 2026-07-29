/** 提纲编辑纯函数：章节编号（中文序号 ↔ 数字）、编号模式识别/重排、组内移动。
 *  提纲页的组顺序/移动/重排都经这里，保证「保存后的提纲 = 导出文档结构」的唯一真相。 */

const CN_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
const CN_VALUE: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 序号 n → 「第X章」（中文数字，1..99 覆盖实际章数）。 */
export function chapterNo(n: number): string {
  const cn =
    n <= 9 ? CN_DIGITS[n]
    : n === 10 ? "十"
    : n < 20 ? `十${CN_DIGITS[n % 10]}`
    : `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ""}`
  return `第${cn}章`
}

/** 中文数字（1..99）→ 整数；解析不了返回 null。 */
function cnToInt(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s.includes("十")) {
    const [tensS = "", unitsS = ""] = s.split("十")
    const tens = tensS ? CN_VALUE[tensS] : 1
    const units = unitsS ? CN_VALUE[unitsS] : 0
    if (tens === undefined || units === undefined) return null
    return tens * 10 + units
  }
  return CN_VALUE[s] ?? null
}

/** 章序号文本 → 阿拉伯数（第七章/第7章/7/七、→ 7）；自定义序号返回 null。 */
export function chapterOrdinal(no: string): number | null {
  const m = /^\s*(?:第\s*([0-9〇零一二三四五六七八九十]{1,3})\s*章|([0-9]{1,2})|([〇零一二三四五六七八九十]{1,3})[、.．])\s*$/.exec(no ?? "")
  if (!m) return null
  return cnToInt(m[1] ?? m[2] ?? m[3] ?? "")
}

/** 子项 label 的层级编号（N.M / N.M.K…）首段改写为章号；无层级编号原样返回。
 *  旧点分编号体系的兼容函数——新建/重排走 LEVEL_NUMBER 的中式编号。 */
export function renumberLabel(label: string, ordinal: number): string {
  return label.replace(/^(\d{1,2})((?:\.\d{1,3})+)/, `${ordinal}$2`)
}

/** 提纲最大层级（章 + 4 层子项）。投标惯例一般到四级足够，五级仅供特别复杂的技术标局部使用。 */
export const MAX_OUTLINE_DEPTH = 5

const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"]

/** 各级编号形态（投标文件通行写法）：
 *  一级 第一章 → 二级 一、 → 三级 1. → 四级 （1） → 五级 ①
 *  逐级**在本层内**顺序编号（不是点分累进）——这是评标专家习惯的读法。 */
export const LEVEL_NUMBER: ((n: number) => string)[] = [
  (n) => chapterNo(n),                                    // L1 章
  (n) => `${intToCn(n)}、`,                                // L2 节
  (n) => `${n}.`,                                         // L3 小节
  (n) => `（${n}）`,                                       // L4 细分
  (n) => CIRCLED[n] ?? `(${n})`,                          // L5 局部细化（超 10 项回落括号数字）
]

/** 整数 → 中文数字（1..99）。 */
function intToCn(n: number): string {
  if (n <= 9) return CN_DIGITS[n] ?? String(n)
  if (n === 10) return "十"
  if (n < 20) return `十${CN_DIGITS[n % 10]}`
  return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ""}`
}

// 已知的各种编号前缀：中式（一、/1./（1）/①）与历史点分式（1.1 / 1.1.1）都要能剥，
// 否则重排会在旧前缀上再叠一层（「一、1.1 项目理解」）。
const NUMBER_PREFIX =
  /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百]{1,3}\s*章|[0-9]{1,2}(?:[.．][0-9]{1,3})+|[〇零一二三四五六七八九十]{1,3}[、.．]|[0-9]{1,2}[、.．)）]|[（(][0-9]{1,2}[）)]|[①-⑩])\s*/

/** 去掉 label 上的任何编号前缀，只留正文标题。 */
export function stripNumberPrefix(label: string): string {
  return label.replace(NUMBER_PREFIX, "")
}

/** 给 label 打上该层级的编号（先剥旧前缀，幂等）。depth 从 0（章）起算。
 *  间隔按中文排版惯例：顿号/右括号后**不留空格**（一、项目理解 /（1）人员配置），其余留一个空格。 */
export function labelWithNumber(label: string, depth: number, seq: number): string {
  const fmt = LEVEL_NUMBER[Math.min(depth, LEVEL_NUMBER.length - 1)]!
  const no = fmt(seq)
  const bare = stripNumberPrefix(label)
  const sep = /[、）)]$/.test(no) ? "" : " "
  return `${no}${sep}${bare}`.trim()
}

type NumberedItem = { label: string; children?: NumberedItem[] }
type NumberedChapter = { no: string; items: NumberedItem[] }
export type NumberMode = "continuous" | "grouped"

/** 子项树逐层重排编号：每层在**本层内**从 1 顺排，形态取该层的 LEVEL_NUMBER。
 *  depth 从 1 起（0 是章，由 chapter.no 承载）。 */
function renumberItems<I extends NumberedItem>(items: I[], depth = 1): I[] {
  return items.map((it, i) => ({
    ...it,
    label: labelWithNumber(it.label, depth, i + 1),
    ...(it.children?.length ? { children: renumberItems(it.children, depth + 1) } : {}),
  }))
}

/** 按组显示顺序重排编号：continuous 全文连续；grouped 各组自起。子项层级编号首段跟随章号。 */
export function applyNumbering<C extends NumberedChapter>(groups: C[][], mode: NumberMode): C[][] {
  let offset = 0
  return groups.map((list) => {
    const next = list.map((c, i) => {
      const n = (mode === "continuous" ? offset : 0) + i + 1
      return { ...c, no: chapterNo(n), items: renumberItems(c.items) } // 子项按本层顺序编号，与章号无关
    })
    offset += list.length
    return next
  })
}

/** 子项树按**位置**重排层级编号（评审二轮 F6:拖拽/删除后 1.2 排在 1.1 前,提纲与导出全乱序）。
 *  编号形态按层级取（一、/1./（1）/①，见 LEVEL_NUMBER）。规则（宁保守勿改错）：
 *  - 已有任意编号前缀的项 → 重写为本层位置序；
 *  - 完全没有编号前缀的项（如刚新增的「新增子项」）原样跳过——不阻断其它项重排，
 *    位置序仍按实际下标计（占位跳号，用户补上编号后下次操作自动纳入）；
 *  - 章号解析不出（自定义编号模式）→ 整树原样不动。 */
export function renumberItemsByPosition<I extends { label: string; children?: I[] }>(items: I[], ordinal: number | null): I[] {
  if (ordinal == null) return items
  const walk = <T extends { label: string; children?: T[] }>(list: T[], depth: number): T[] =>
    list.map((it, i) => {
      if (!NUMBER_PREFIX.test(it.label)) return it
      return {
        ...it,
        label: labelWithNumber(it.label, depth, i + 1),
        ...(it.children?.length ? { children: walk(it.children, depth + 1) } : {}),
      }
    })
  return walk(items, 1)
}

/** 子项树展平（节+小节顺序铺开）：统计徽标/计数共用。 */
export function flattenItems<I extends { children?: I[] }>(list: I[]): I[] {
  return list.flatMap((it) => [it, ...flattenItems(it.children ?? [])])
}

/** 子项树序列化（保存回写 Outline 契约）：children 递归透传——丢了这个键=丢用户的小节。 */
export function serializeItems(
  list: Array<{ id: string; label: string; clauseIds?: string[]; isNew?: boolean; children?: unknown[] }>,
): unknown[] {
  return list.map((it) => ({
    id: it.id,
    label: it.label,
    clauseIds: it.clauseIds ?? [],
    isNew: it.isNew ?? false,
    children: serializeItems((it.children ?? []) as Parameters<typeof serializeItems>[0]),
  }))
}

/** 同层拖拽重排（评审需求:子项在本章内、小节在本节内拖动）：把 dragId 移到 dropId 之前；
 *  dropId 为 null 移到末尾；任一 id 不在本层原样返回（跨层拖拽由调用方先行拦截,这里兜底）。 */
export function reorderWithin<T extends { id: string }>(list: T[], dragId: string, dropId: string | null): T[] {
  const from = list.findIndex((x) => x.id === dragId)
  if (from < 0 || dragId === dropId) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  const at = dropId == null ? next.length : next.findIndex((x) => x.id === dropId)
  if (at < 0) return list
  next.splice(at, 0, moved!)
  return next
}

/** 从实际编号识别当前模式（严格匹配 chapterNo 生成的中文序号才算；单组时两模式等价，归 grouped）；
 *  否则 custom——含「第7章」等非标准写法：宁可停用自动重排，也不擅自改写用户手写的编号（有意的保守）。 */
export function deriveNumberMode(groups: NumberedChapter[][]): NumberMode | "custom" {
  const matches = (mode: NumberMode) => {
    let offset = 0
    for (const list of groups) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.no !== chapterNo((mode === "continuous" ? offset : 0) + i + 1)) return false
      }
      offset += list.length
    }
    return true
  }
  if (groups.filter((g) => g.length > 0).length <= 1) return matches("grouped") ? "grouped" : "custom"
  if (matches("continuous")) return "continuous"
  if (matches("grouped")) return "grouped"
  return "custom"
}

/** 组内移动章节（dir=-1 上移 / 1 下移）；越界原样返回。 */
export function moveChapter<C extends { id: string }>(list: C[], id: string, dir: -1 | 1): C[] {
  const i = list.findIndex((c) => c.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return list
  const next = [...list]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}
