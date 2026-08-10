import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { slideStyles } from "@/lib/present"

/* 模板选择器 vs 真实渲染器：id 与色值都直接读 agent 端的设计令牌来比。
 * 这两处历史上各写各的——渲染器加了模板而选择器没跟，用户就在界面上看不到；
 * 选择器挑个"最接近的"调色板名，导出的 PPT 又和预览对不上（品牌红那次就是这么来的）。 */
const STYLES_PY = `${import.meta.dir}/../../../services/agent/src/agent/agents/bidding_agent/render/styles.py`
const py = readFileSync(STYLES_PY, "utf8")

/** styles.py 里每套模板的 _tokens(...) 调用体 */
function tokenBlocks(): Map<string, string> {
  const table = py.slice(py.indexOf("TEMPLATE_TOKENS"), py.indexOf("DEFAULT_TEMPLATE"))
  const starts = [...table.matchAll(/"(\w+)":\s*_tokens\(/g)]
  const out = new Map<string, string>()
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : table.length
    out.set(m[1]!, table.slice(m.index!, end))
  })
  return out
}

/** 一套模板令牌里出现的所有颜色，统一成 #RRGGBB（styles.py 里十进制/十六进制两种写法都有） */
function colorsOf(block: string): Set<string> {
  const set = new Set<string>()
  for (const m of block.matchAll(/RGBColor\(\s*([\w+x]+),\s*([\w+x]+),\s*([\w+x]+)\s*\)/g)) {
    const hex = [m[1]!, m[2]!, m[3]!]
      .map((v) => Number(v).toString(16).padStart(2, "0"))
      .join("")
    set.add(`#${hex.toUpperCase()}`)
  }
  return set
}

describe("述标模板：选择器与渲染器同源", () => {
  it("解析得到 agent 端模板表（解析不出来说明 styles.py 结构变了，下面的断言就都是假绿）", () => {
    expect(tokenBlocks().size).toBeGreaterThan(0)
  })

  it("模板 id 集合与 agent 端逐个一致——渲染器有的选择器必须有，反之亦然", () => {
    const agentIds = [...tokenBlocks().keys()].sort()
    const webIds = slideStyles.map((s) => s.id).sort()
    expect(webIds).toEqual(agentIds)
  })

  it("色块取自渲染器真实输出色，不许挑近似色", () => {
    const blocks = tokenBlocks()
    for (const style of slideStyles) {
      const allowed = colorsOf(blocks.get(style.id)!)
      // chip/accent 是浅底 UI 上的小字，深色模板需要降一档才读得出来，故不参与比色
      for (const cls of [style.swatch, style.coverBg, style.bar, style.dot]) {
        const hex = cls.match(/#[0-9A-Fa-f]{6}/)?.[0]?.toUpperCase()
        expect(hex, `${style.id} 的 ${cls} 没有写死十六进制色`).toBeTruthy()
        expect([...allowed], `${style.id} 的 ${cls} 不在渲染器令牌色里`).toContain(hex!)
      }
    }
  })
})
