import { describe, expect, test } from "bun:test"
import { appendixStale, placeholderFileIds, SYS_CREDS_ID } from "../lib/credentials-appendix"

describe("placeholderFileIds", () => {
  test("逐个抠占位图的 data-file-id（Task 2/4 两端同形的自闭合 <img> 形态）", () => {
    const html =
      '<h3>营业执照</h3>\n<p><img data-file-id="f1" data-object-key="k1" alt="营业执照" /></p>' +
      '<h3>资质证书</h3>\n<p><img data-file-id="f2" data-object-key="k2" alt="资质证书" /></p>'
    expect(placeholderFileIds(html)).toEqual(["f1", "f2"])
  })

  test("已解析出 src、属性顺序被 TipTap 打乱也照抠不误（编辑器保存后的往返形态）", () => {
    const html = '<img alt="营业执照" src="https://minio/presigned" data-object-key="k1" data-file-id="f1">'
    expect(placeholderFileIds(html)).toEqual(["f1"])
  })

  test("单引号属性值同样识别", () => {
    expect(placeholderFileIds("<img data-file-id='f9' alt='x'>")).toEqual(["f9"])
  })

  test("空 HTML / 无占位图 → 空数组", () => {
    expect(placeholderFileIds("")).toEqual([])
    expect(placeholderFileIds("<p>正文没有图片</p>")).toEqual([])
  })

  test("普通插图（无 data-file-id，如资料库文本条目内嵌的 data URL 图）不计入", () => {
    expect(placeholderFileIds('<img src="data:image/png;base64,AAA" alt="x">')).toEqual([])
  })
})

describe("appendixStale", () => {
  test("集合相同（顺序不同）即不过期", () => {
    expect(appendixStale(["f1", "f2"], ["f2", "f1"])).toBe(false)
  })

  test("资料库多了一张证照 → 过期", () => {
    expect(appendixStale(["f1"], ["f1", "f2"])).toBe(true)
  })

  test("资料库删了一张证照 → 过期", () => {
    expect(appendixStale(["f1", "f2"], ["f1"])).toBe(true)
  })

  test("同样数量但元素不同（一增一减）→ 过期", () => {
    expect(appendixStale(["f1", "f2"], ["f1", "f3"])).toBe(true)
  })

  test("两边都空 → 不过期", () => {
    expect(appendixStale([], [])).toBe(false)
  })
})

test("SYS_CREDS_ID 与 App/agent 两端字面量同形", () => {
  expect(SYS_CREDS_ID).toBe("sys-creds")
})
