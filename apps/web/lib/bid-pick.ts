import type { ProjectListItem } from "@/lib/project"

// 「从我的标书选择」两个列表的可选性判定。抽成纯函数是因为它直接挡在**计费**前面：
// 列出一个其实用不了的项目，用户选中后轻则空转，重则真的跑起来扣掉积分
// （用户口径：防止选错文件也把人家的积分扣了）。规则改动必须同时改这里的测试。

/** 已生成正文（走到 review 及之后）或线下上传的标书 —— 即"手里确实有一份投标文件"。 */
const HAS_BID_STEPS = ["review", "present", "export", "done"]

/** 述标可选：只能选**已经有投标文件**的项目（用户口径）。
 *  bid-kind 还要求走到 present 之后——currentStep='review' 时后端述标闸会 409（见 projects.ts 步序闸），
 *  列进来只会让用户选中后空转回入口。线下标书（kind='review'）不受此限：有标书就能随时述标。 */
export function presentable(p: ProjectListItem): boolean {
  if (p.hasBid === false) return false
  return p.kind === "review" || ["present", "export", "done"].includes(p.currentStep)
}

/** 废标审查可选：招标文件与投标文件**是一体的**（用户口径：不允许单独拿投标文件做废标审查）——
 *  废标体检就是拿招标要求逐条比对投标内容，缺了招标文件无从判定，跑起来只是白扣积分。 */
export function reviewable(p: ProjectListItem): boolean {
  // 失败方向与 presentable 一致：字段缺失（web 先于 api 发版 / 旧缓存）视为未知而放行，
  // 只有后端明确回了 0 份招标文件才排除——否则整个列表会静默空掉，比列多了更糟。
  return p.hasBid !== false && p.tenderCount !== 0 && HAS_BID_STEPS.includes(p.currentStep)
}
