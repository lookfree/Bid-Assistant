import { lockRiskAdvice } from "./entitlements"

/** SSE 中继帧过滤（评审二轮 F1）：agent 自身的 step.done/node.end 事件带全量 review 结果，
 *  经 relayStream 原样透传——非会员在审查运行中即可从网络帧读到整改建议（App 只裁了自己
 *  追加的终帧与 REST 读取,等于门没关严）。本器对中继分片做帧级缓冲：凡 `data:` 行 JSON 的
 *  data.result / data.delta 命中 RiskReport 形态（含 items[].advice）一律经 lockRiskAdvice
 *  裁剪后转发；心跳注释帧、非 JSON 行、其他事件原样。仅 review 步且请求者非会员时挂载
 *  （见 projects.ts 两个中继点）,其余路径零开销。 */
export function createAdviceScrubber() {
  let buf = ""

  const scrubLine = (ln: string): string => {
    if (!ln.startsWith("data: ")) return ln
    try {
      const ev = JSON.parse(ln.slice(6)) as { data?: Record<string, unknown> }
      if (ev == null || typeof ev !== "object" || ev.data == null || typeof ev.data !== "object") return ln
      let touched = false
      for (const k of ["result", "delta"] as const) {
        const scrubbed = lockRiskAdvice(ev.data[k])
        if (scrubbed !== ev.data[k]) {
          ev.data[k] = scrubbed
          touched = true
        }
      }
      return touched ? `data: ${JSON.stringify(ev)}` : ln
    } catch {
      return ln // 非 JSON data 行（不该出现）原样,绝不因裁剪失败断流
    }
  }

  const scrubFrame = (frame: string): string => frame.split("\n").map(scrubLine).join("\n")

  return {
    /** 喂入一个中继分片，返回可安全下发的完整帧串（不足一帧的尾部留在缓冲）。 */
    push(chunk: string): string {
      buf += chunk
      let out = ""
      let i: number
      while ((i = buf.indexOf("\n\n")) !== -1) {
        out += scrubFrame(buf.slice(0, i)) + "\n\n"
        buf = buf.slice(i + 2)
      }
      return out
    },
    /** 流结束时取出残余缓冲（正常流以空行收尾,残余通常为空）。 */
    flush(): string {
      const rest = buf
      buf = ""
      return rest
    },
  }
}
