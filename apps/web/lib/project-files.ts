import type { ProjectListItem } from "./project"

// 项目的「文件构成」一行文案。两处入口共用：我的标书卡片、审查/述标的选择器。
//
// 为什么需要它：列表每行过去只渲染一个 `name`，而这个名字是**派生**的——生成项目取招标文件名，
// 线下审查项目取投标文件名。同一个位置两种含义，于是用户既看不出「我传了几份」，也分不清
// 「我选的这一行到底是招标文件还是投标文件」（2026-08-11 用户实测提问）。
//
// 两类项目的区别必须写在脸上：
//   生成项目（kind=bid）   ：用户传招标文件，投标正文由系统生成
//   线下审查（kind=review）：招标文件与投标文件都是用户上传的

/** 「生成项目」/「线下审查」——项目是哪一类。 */
export function kindLabel(p: ProjectListItem): string {
  return p.kind === "review" ? "线下审查" : "生成项目"
}

/** 投标文件那一段：线下项目报份数，生成项目报生成状态（它的正文不在文件表里）。
 *  **字段缺失 = 未知，不是缺失**：bidFiles 是可选字段（web 先于 api 发版 / 旧缓存就没有），
 *  按 0 处理会让选择列表一边写着「投标文件缺失」，一边照样把这个项目摆出来让人花 60 积分审查
 *  ——lib/bid-pick 的 reviewable() 对同一情形是刻意放行的，两处口径不能相反。 */
function bidPart(p: ProjectListItem): string | null {
  if (p.kind !== "review") return p.hasBid ? "投标已生成" : "投标待生成"
  if (p.bidFiles === undefined) return null              // 未知：这一段整个不说
  return p.bidFiles.length ? `投标 ${p.bidFiles.length} 份` : "投标文件缺失"
}

/** 招标文件那一段。述标建的线下项目**本来就不传招标文件**（standalone-bid-entry 的 bidOnly
 *  路径传的是空数组），对它说「无招标文件」像在报故障,其实一切正常——这种情况不说这一段。 */
function tenderPart(p: ProjectListItem): string | null {
  const n = p.tenderFiles?.length ?? p.tenderCount
  if (n === undefined) return null
  return n ? `招标 ${n} 份` : null
}

/** 一行构成摘要：「生成项目 · 招标 2 份 · 投标已生成」。说不准的段直接不说，不猜也不报错。 */
export function fileSummary(p: ProjectListItem): string {
  return [kindLabel(p), tenderPart(p), bidPart(p)].filter(Boolean).join(" · ")
}

/** 悬停展开的逐份文件名。摘要只给数字，用户还要能确认**具体是哪几份**（传漏补遗是废标常客）。
 *  没有任何文件名可报时返回 undefined——别给一个空 tooltip。 */
export function fileTitle(p: ProjectListItem): string | undefined {
  const lines: string[] = []
  if (p.tenderFiles?.length) lines.push(`招标文件：\n${p.tenderFiles.map((n) => `· ${n}`).join("\n")}`)
  if (p.bidFiles?.length) lines.push(`投标文件：\n${p.bidFiles.map((n) => `· ${n}`).join("\n")}`)
  return lines.length ? lines.join("\n") : undefined
}
