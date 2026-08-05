// 「今天」一律按北京时间算，与容器时区无关。
//
// 由来：230 的 api 容器是 UTC（`date` 输出 UTC、TZ 变量为空），而看板原先用
// `new Date().setHours(0,0,0,0)` 取容器本地零点 → 「今日」从北京时间早上 8 点起算，
// 00:00–08:00 的订单被算进昨天。同一页的趋势图却已锚定 Asia/Shanghai（见 overview.ts 的
// dayExpr），两个「今天」日界不一致，数字自然对不上。

export const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 给定时刻所属**北京日**的零点（返回该零点对应的 UTC 时刻，可直接与 timestamptz 比较）。
 *  中国全境单一时区且不实行夏令时，固定 +8 偏移即可，无需时区库。 */
export function beijingTodayStart(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS) // 把 UTC 时刻挪成北京墙钟
  shifted.setUTCHours(0, 0, 0, 0) // 在墙钟上取零点
  return new Date(shifted.getTime() - BEIJING_OFFSET_MS) // 换回 UTC 时刻
}
