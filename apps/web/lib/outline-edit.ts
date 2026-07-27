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

/** 子项 label 的层级编号（N.M / N.M.K…）首段改写为章号；无层级编号原样返回。 */
export function renumberLabel(label: string, ordinal: number): string {
  return label.replace(/^(\d{1,2})((?:\.\d{1,3})+)/, `${ordinal}$2`)
}

type NumberedChapter = { no: string; items: { label: string }[] }
export type NumberMode = "continuous" | "grouped"

/** 按组显示顺序重排编号：continuous 全文连续；grouped 各组自起。子项层级编号首段跟随章号。 */
export function applyNumbering<C extends NumberedChapter>(groups: C[][], mode: NumberMode): C[][] {
  let offset = 0
  return groups.map((list) => {
    const next = list.map((c, i) => {
      const n = (mode === "continuous" ? offset : 0) + i + 1
      return { ...c, no: chapterNo(n), items: c.items.map((it) => ({ ...it, label: renumberLabel(it.label, n) })) }
    })
    offset += list.length
    return next
  })
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
