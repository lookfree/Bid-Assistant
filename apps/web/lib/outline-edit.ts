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
// 小数陷阱（评审）：标题里的小数不是编号——「3.5吨叉车配置方案」「2.5G承载网建设」若按点分式剥掉，
// 数字就永久丢了。故点分式要求后接空白/顿号/结尾，单个数字后的点要求不接数字；宁可少剥（多一层
// 前缀只是难看）也不错剥（吃掉标题里的数字是不可逆的数据损失）。
const NUMBER_PREFIX = new RegExp(
  "^\\s*(?:" +
    "第\\s*[0-9〇零一二三四五六七八九十百]{1,3}\\s*章" +
    "|[0-9]{1,2}(?:[.．][0-9]{1,3})+(?=[\\s、]|$)" + // 历史点分式 1.1 / 1.1.1
    "|[〇零一二三四五六七八九十]{1,3}[、.．]" +
    "|[0-9]{1,2}[、)）]" +
    "|[0-9]{1,2}[.．](?![0-9])" + // 「1. 项目背景」是编号，「3.5吨」不是
    "|[（(][0-9]{1,2}[）)]" +
    "|[①-⑩]" +
    ")\\s*",
)

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

/** 按组显示顺序重排**章号**：continuous 全文连续；grouped 各组自起。
 *  只动 no，不动子项：子项编号在本层内顺排、与章号无关（见 LEVEL_NUMBER），加一章不该把
 *  另一组用户手写的小节标题全部重写一遍（评审：加 1 章 → 技术标全树被剥前缀重编）。
 *  子项编号由子项自身的增删/拖拽触发 renumberItemsByPosition。 */
export function applyNumbering<C extends NumberedChapter>(groups: C[][], mode: NumberMode): C[][] {
  let offset = 0
  return groups.map((list) => {
    const next = list.map((c, i) => ({ ...c, no: chapterNo((mode === "continuous" ? offset : 0) + i + 1) }))
    offset += list.length
    return next
  })
}

/** 子项树按**位置**重排层级编号（评审二轮 F6:拖拽/删除后 1.2 排在 1.1 前,提纲与导出全乱序）。
 *  编号形态按层级取（一、/1./（1）/①，见 LEVEL_NUMBER），与章号无关——所以「附录A」这类
 *  自定义章号的章同样重排（评审：旧版按章号解析失败就整树不动，二、会留在 一、上面）。
 *  规则（宁保守勿改错）：已有编号前缀的项重写为本层位置序；完全没编号的项（如刚新增的
 *  「新增子项」）保留原文不打编号，但**其子树照常重排**——否则一个没编号的父项会把整条
 *  分支冻在乱序上（五级提纲下分支可深达 4 层）。位置序按实际下标计（占位跳号）。 */
export function renumberItemsByPosition<I extends { label: string; children?: I[] }>(items: I[]): I[] {
  const walk = <T extends { label: string; children?: T[] }>(list: T[], depth: number): T[] =>
    list.map((it, i) => ({
      ...it,
      ...(NUMBER_PREFIX.test(it.label) ? { label: labelWithNumber(it.label, depth, i + 1) } : {}),
      ...(it.children?.length ? { children: walk(it.children, depth + 1) } : {}),
    }))
  return walk(items, 1)
}

/** 子项树展平（节+小节顺序铺开）：统计徽标/计数共用。 */
export function flattenItems<I extends { children?: I[] }>(list: I[]): I[] {
  return list.flatMap((it) => [it, ...flattenItems(it.children ?? [])])
}

/** 子项树序列化（保存回写 Outline 契约）：children 递归透传——丢了这个键=丢用户的小节。 */
export function serializeItems(
  list: Array<{ id: string; label: string; desc?: string; clauseIds?: string[]; isNew?: boolean; children?: unknown[] }>,
): unknown[] {
  return list.map((it) => ({
    id: it.id,
    label: it.label,
    // 用户手写的写作说明（新增标题时可填），随提纲一并保存并进入正文生成提示词。
    // 序列化按白名单重建对象——漏掉它就是「填了、显示了、一保存就没了」，且毫无提示。
    desc: it.desc ?? "",
    clauseIds: it.clauseIds ?? [],
    isNew: it.isNew ?? false,
    children: serializeItems((it.children ?? []) as Parameters<typeof serializeItems>[0]),
  }))
}

export type OutlineChapterInput = {
  id: string
  no: string
  title: string
  sourced?: boolean
  structureRef?: string | null
  desc?: string
  /** 系统生成章标记（如资格证明文件附录 sys-creds）：保存回写必须透传——剥掉这个键=附录被模型
   *  重写（sourceFileId 同类教训第三次，终审 C1）。 */
  system?: boolean
  /** 拆章锚（2026-08-15 提纲拆章）：拆出的表单章重排时锁在父章之后。保存回写必须透传——
   *  白名单剥掉它=用户存一次提纲，拆出章丢父绑定（system/sourceFileId 同类教训第四次）。 */
  afterId?: string
  /** 商务表单章的招标文档序（提纲代码定版）：保存回写透传，理由同 afterId。 */
  formOrder?: number
  items: Parameters<typeof serializeItems>[0]
}

/** 章节树 → 后端 Outline 契约。保存回写与「有没有未保存改动」的判断**共用这一份**：
 *  两处口径一旦漂移，就会出现「显示已保存、其实没存」或者反复空存。
 *  数组顺序即成书顺序（导出/正文页跟随），故组顺序在这里落定。 */
export function buildOutlinePayload(
  tech: OutlineChapterInput[],
  business: OutlineChapterInput[],
  bizFirst: boolean,
): unknown[] {
  const one = (list: OutlineChapterInput[], group: "tech" | "business") =>
    list.map((ch) => ({
      id: ch.id,
      no: ch.no,
      title: ch.title,
      group,
      sourced: ch.sourced,
      structureRef: ch.structureRef ?? null,
      desc: ch.desc ?? "",
      // system 键只在系统章（如 sys-creds）上出现——原样透传，undefined 时序列化自然不落这个键，
      // 普通章不受影响。丢了它 = 附录被当普通章送模型改写（终审 C1）。
      system: ch.system,
      afterId: ch.afterId,
      formOrder: ch.formOrder,
      items: serializeItems(ch.items),
    }))
  return bizFirst
    ? [...one(business, "business"), ...one(tech, "tech")]
    : [...one(tech, "tech"), ...one(business, "business")]
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
