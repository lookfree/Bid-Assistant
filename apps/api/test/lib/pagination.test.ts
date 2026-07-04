import { describe, it, expect } from "bun:test"
import { parsePagination } from "../../src/lib/pagination"

describe("spec308 分页解析", () => {
  it("默认 page=1 pageSize=20 offset=0", () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 20, offset: 0 })
  })

  it("page=3 pageSize=10 → offset=20", () => {
    expect(parsePagination({ page: "3", pageSize: "10" })).toEqual({ page: 3, pageSize: 10, offset: 20 })
  })

  it("pageSize 超 100 被截断到 100", () => {
    expect(parsePagination({ pageSize: "1000" }).pageSize).toBe(100)
  })

  it("page 非法（非数字/0/负）抛错 → 路由转 400", () => {
    expect(() => parsePagination({ page: "abc" })).toThrow()
    expect(() => parsePagination({ page: "0" })).toThrow()
    expect(() => parsePagination({ page: "-1" })).toThrow()
  })
})
