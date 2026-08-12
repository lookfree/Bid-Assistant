import { describe, it, expect, beforeEach } from "bun:test"

// bun test 没有 DOM：自己装一个最小 sessionStorage，行为与浏览器一致即可
const store = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}
;(globalThis as { window?: unknown }).window = globalThis

const { markUploading, clearUploading, isUploading } = await import("@/lib/upload-progress")

describe("在途上传标记", () => {
  beforeEach(() => store.clear())

  it("标记在时，切回该页能知道还在传", () => {
    markUploading("/risk")
    expect(isUploading("/risk")).toBe(true)
  })

  it("只认自己那一页：述标在传不该让审查页显示进行中", () => {
    markUploading("/present")
    expect(isUploading("/risk")).toBe(false)
  })

  it("传完必须清掉，否则用户永远卡在进行中态", () => {
    markUploading("/risk")
    clearUploading()
    expect(isUploading("/risk")).toBe(false)
  })

  it("过期标记自动失效：硬刷新会杀掉在途请求，标记却留在 sessionStorage 里", () => {
    store.set("bid.uploading", JSON.stringify({ page: "/risk", at: Date.now() - 16 * 60 * 1000 }))
    expect(isUploading("/risk")).toBe(false)
    expect(store.get("bid.uploading")).toBeUndefined() // 顺手清掉，不留给下次误判
  })

  it("15 分钟内仍然有效（5 份大文件在客户网络上要传很久）", () => {
    store.set("bid.uploading", JSON.stringify({ page: "/risk", at: Date.now() - 14 * 60 * 1000 }))
    expect(isUploading("/risk")).toBe(true)
  })

  it("坏数据不会把页面卡死", () => {
    store.set("bid.uploading", "{不是 JSON")
    expect(isUploading("/risk")).toBe(false)
  })
})
