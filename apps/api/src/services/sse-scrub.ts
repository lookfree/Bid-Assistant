import { lockRiskAdvice } from "./entitlements"

/** SSE 中继帧过滤（评审二轮 F1）：agent 自身的 step.done/node.end 事件带全量 review 结果，
 *  经 relayStream 原样透传——非会员在审查运行中即可从网络帧读到整改建议（App 只裁了自己
 *  追加的终帧与 REST 读取,等于门没关严）。本器对中继分片做帧级缓冲：凡 `data:` 行 JSON 的
 *  data.result / data.delta 命中 RiskReport 形态（含 items[].advice）一律经 lockRiskAdvice
 *  裁剪后转发；心跳注释帧、非 JSON 行、其他事件原样。仅 review 步且请求者非会员时挂载
 *  （见 projects.ts 两个中继点）,其余路径零开销。 */
/** 载荷裁剪：先按 RiskReport 直形状试（step.done 的 data.result 就是它）；不命中且是普通对象时，
 *  再对其**每个直接子值**试一次——node.end 的 data.delta 是 LangGraph 的 `{<节点名>: 节点返回值}`
 *  包装（review 节点返回 {"risk": RiskReport}），只看顶层会整帧放行（三轮核验实测泄漏）。
 *  只下探一层：delta 的包装深度恒为 1，再深就成了对任意结构的盲目遍历。 */
function scrubPayload(v: unknown): unknown {
  const direct = lockRiskAdvice(v)
  if (direct !== v) return direct
  if (v == null || typeof v !== "object" || Array.isArray(v)) return v
  const obj = v as Record<string, unknown>
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(obj)) {
    const scrubbed = lockRiskAdvice(val)
    if (scrubbed !== val) touched = true
    out[k] = scrubbed
  }
  return touched ? out : v
}

export function createAdviceScrubber() {
  let buf = ""

  const scrubLine = (ln: string): string => {
    if (!ln.startsWith("data: ")) return ln
    try {
      const ev = JSON.parse(ln.slice(6)) as { data?: Record<string, unknown> }
      if (ev == null || typeof ev !== "object" || ev.data == null || typeof ev.data !== "object") return ln
      let touched = false
      for (const k of ["result", "delta"] as const) {
        const scrubbed = scrubPayload(ev.data[k])
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
    /** 流结束时取出残余缓冲（正常流以空行收尾,残余通常为空）。
     *  残余同样要过裁剪：末帧未以空行收尾时（agent 中途掉线/流被截断）整帧滞留在这里，
     *  原样归还等于让最后一帧——恰恰是携带完整结果的那帧——绕过裁剪裸奔出网（实测泄漏）。 */
    flush(): string {
      const rest = buf
      buf = ""
      return rest ? scrubFrame(rest) : rest
    },
  }
}
