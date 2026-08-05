import { describe, it, expect } from "bun:test"
import { beijingTodayStart, BEIJING_OFFSET_MS } from "../../src/lib/beijing-day"

// 看板「今日」此前用 new Date().setHours(0,0,0,0)，取的是**容器本地时区**。
// 230 的 api 容器是 UTC（实测 `date` 输出 UTC，TZ 变量为空），于是「今天」从北京时间早上 8 点起算：
// 北京时间 00:00–08:00 的订单会被算进昨天。同一页的趋势图却已锚定 Asia/Shanghai，两个日界对不上。
describe("北京日零点", () => {
  const bj = (s: string) => new Date(s) // 传 UTC 时刻

  it("北京时间 08:00（= UTC 00:00）属于当天，日界是前一日 UTC 16:00", () => {
    expect(beijingTodayStart(bj("2026-08-05T00:00:00Z")).toISOString()).toBe("2026-08-04T16:00:00.000Z")
  })

  it("北京时间 00:30（= UTC 前一日 16:30）已经算新的一天", () => {
    // 旧实现在 UTC 容器里会把这一刻算成"昨天"，订单掉进前一日
    expect(beijingTodayStart(bj("2026-08-04T16:30:00Z")).toISOString()).toBe("2026-08-04T16:00:00.000Z")
  })

  it("北京时间 23:59 仍是当天", () => {
    expect(beijingTodayStart(bj("2026-08-05T15:59:59Z")).toISOString()).toBe("2026-08-04T16:00:00.000Z")
  })

  it("跨到北京时间次日 00:00 即翻页", () => {
    expect(beijingTodayStart(bj("2026-08-05T16:00:00Z")).toISOString()).toBe("2026-08-05T16:00:00.000Z")
  })

  it("结果与运行环境时区无关——同一时刻永远得到同一个日界", () => {
    const t = bj("2026-08-05T10:23:49Z") // 北京 18:23，实测那笔 ¥39 订单
    expect(beijingTodayStart(t).getTime()).toBe(bj("2026-08-04T16:00:00Z").getTime())
    expect(BEIJING_OFFSET_MS).toBe(8 * 3600 * 1000)
  })
})
