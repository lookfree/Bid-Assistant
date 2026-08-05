import { describe, it, expect } from "bun:test"
import { checkFileMagic, TSD_WRAPPER_HEADER } from "../../src/services/file-magic"

const enc = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff])
const CFB = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

describe("checkFileMagic — 加密封装", () => {
  it("认出文档加密软件的封装头，并给出可执行的下一步", () => {
    const v = checkFileMagic(cat(enc(TSD_WRAPPER_HEADER), new Uint8Array(64)), "pdf")
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe("encrypted_wrapper")
  })

  it("封装头与原格式无关，.docx 上一样认出来", () => {
    const v = checkFileMagic(cat(enc(TSD_WRAPPER_HEADER), enc("rubbish")), "docx")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("encrypted_wrapper")
  })
})

describe("checkFileMagic — 内容与扩展名不符", () => {
  for (const [ext, magic] of [
    ["pdf", enc("%PDF-1.7")],
    ["docx", ZIP],
    ["xlsx", ZIP],
    ["pptx", ZIP],
    ["potx", ZIP],
    ["png", PNG],
    ["jpg", JPEG],
    ["jpeg", JPEG],
  ] as const) {
    it(`.${ext} 头对 → 放行`, () => {
      expect(checkFileMagic(cat(magic as Uint8Array, new Uint8Array(32)), ext).ok).toBe(true)
    })
    it(`.${ext} 头不对 → 拦下并说明是内容与扩展名不符`, () => {
      const v = checkFileMagic(enc("plain text, not a document at all"), ext)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.code).toBe("content_mismatch")
    })
  }

  it("PDF 头前有少量前导字节仍放行（规范容忍，解析器也容忍）", () => {
    expect(checkFileMagic(cat(enc("\n\n"), enc("%PDF-1.4")), "pdf").ok).toBe(true)
  })

  it("doc/xls 不做正向魔数校验：RTF 或 docx 装在 .doc 里是历史常见写法，LibreOffice 能转", () => {
    expect(checkFileMagic(enc("{\\rtf1\\ansi"), "doc").ok).toBe(true)
    expect(checkFileMagic(ZIP, "doc").ok).toBe(true)
    expect(checkFileMagic(CFB, "xls").ok).toBe(true)
  })

  it("doc/xls 仍拦已知的加密封装头", () => {
    const v = checkFileMagic(enc(TSD_WRAPPER_HEADER), "doc")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("encrypted_wrapper")
  })

  it("未知扩展名不拦（白名单在别处把关，这里不重复且不误伤）", () => {
    expect(checkFileMagic(enc("whatever"), "txt").ok).toBe(true)
  })

  it("空文件按内容不符拦下，不放进后续流程", () => {
    expect(checkFileMagic(new Uint8Array(0), "pdf").ok).toBe(false)
  })
})
