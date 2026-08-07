/**
 * 保存失败的用户可读文案。
 *
 * 提纲页改成自动保存之后，这行字是用户判断「我的改动到底存没存上」的唯一依据——
 * 说错了就会让人做错决定：把「网太慢，等一下再试」说成「保存失败」，用户会拿同一份内容
 * 反复原样重试；把超时说成「该步骤还未生成」更是南辕北辙。
 */
import { describe, it, expect } from "bun:test"
import { patchErrorMessage } from "@/lib/project"
import { ApiError } from "@/lib/api-client"

describe("patchErrorMessage", () => {
  it("404（该步没有 done 结果）→ 指向真正该做的事", () => {
    expect(patchErrorMessage(new ApiError(404, "step_not_done"))).toContain("还未生成")
  })

  it("超时 → 说明是网络慢，而不是内容被拒", () => {
    // AbortSignal.timeout 抛的就是这个：DOMException，name=TimeoutError
    const msg = patchErrorMessage(new DOMException("signal timed out", "TimeoutError"))
    expect(msg).toContain("超时")
    expect(msg).not.toContain("还未生成")
  })

  it("其它错误 → 通用重试文案", () => {
    expect(patchErrorMessage(new ApiError(500, "boom"))).toBe("保存失败，请重试")
    expect(patchErrorMessage(new Error("network"))).toBe("保存失败，请重试")
  })
})
