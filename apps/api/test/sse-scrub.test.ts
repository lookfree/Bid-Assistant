import { describe, expect, it } from "bun:test"
import { createAdviceScrubber } from "../src/services/sse-scrub"

// 评审二轮 F1：review 的 agent SSE 事件带全量整改建议原样透传——非会员中继必须帧级裁剪。
// 本套件锁定:任意分片切割下 result/delta 的 items[].advice 被清空、其余帧字节级原样。
const riskEvent = (key: "result" | "delta") =>
  `event: step.done\ndata: ${JSON.stringify({
    type: "step.done", node: "review",
    data: { [key]: { score: 45, items: [{ title: "缺认证", advice: "补 ISO27001" }], passed_items: [] } },
  })}\n\n`

const adviceOf = (frame: string) =>
  (JSON.parse(frame.split("\ndata: ")[1]!.split("\n")[0]!) as { data: { result?: { items: { advice: string }[]; adviceLocked?: boolean } } })

describe("createAdviceScrubber", () => {
  it("整帧到达:result 与 delta 的 advice 都被清空并带 adviceLocked", () => {
    for (const key of ["result", "delta"] as const) {
      const s = createAdviceScrubber()
      const out = s.push(riskEvent(key))
      expect(out).toContain("event: step.done")
      expect(out).not.toContain("补 ISO27001")
      const payload = (JSON.parse(out.split("\ndata: ")[1]!.split("\n")[0]!) as { data: Record<string, { items: { advice: string }[] }> }).data[key]!
      expect(payload.items[0]!.advice).toBe("")
    }
  })

  it("跨分片切割的帧同样被裁剪;不足一帧不下发", () => {
    const s = createAdviceScrubber()
    const frame = riskEvent("result")
    const cut = Math.floor(frame.length / 2)
    expect(s.push(frame.slice(0, cut))).toBe("") // 半帧滞留缓冲
    const out = s.push(frame.slice(cut))
    expect(out).not.toContain("补 ISO27001")
    expect(adviceOf(out).data.result!.items[0]!.advice).toBe("")
    expect(adviceOf(out).data.result!.adviceLocked).toBe(true)
  })

  it("心跳注释帧/非风险载荷/非 JSON 行 全部字节级原样", () => {
    const s = createAdviceScrubber()
    const hb = ": hb\n\n"
    const progress = `event: chapter.progress\ndata: ${JSON.stringify({ type: "chapter.progress", data: { done: 3 } })}\n\n`
    expect(s.push(hb)).toBe(hb)
    expect(s.push(progress)).toBe(progress)
    const weird = "data: not-json\n\n"
    expect(s.push(weird)).toBe(weird)
    expect(s.flush()).toBe("")
  })

  it("flush 归还残余缓冲（异常断流时不丢字节）", () => {
    const s = createAdviceScrubber()
    s.push("event: run.end\ndata: {\"type\"")
    expect(s.flush()).toBe("event: run.end\ndata: {\"type\"")
  })
})
