import { describe, it, expect } from "bun:test"
import { permLabel, actionLabel, diffRows } from "../lib/admin-labels"

describe("运营后台展示映射：中文标签兜底", () => {
  it("权限项/操作命中中文，未命中回退原键", () => {
    expect(permLabel("config.write")).toBe("写入系统配置")
    expect(actionLabel("refund.done")).toBe("退款成功")
    expect(permLabel("unknown.perm")).toBe("unknown.perm")
    expect(actionLabel("unknown.action")).toBe("unknown.action")
  })
})

describe("审计 diffRows：字段级前后对照", () => {
  it("合并两侧键，同值不标 changed，异值标 changed", () => {
    const rows = diffRows({ role: "ops", status: "active" }, { role: "finance", status: "active" })
    expect(rows.find((r) => r.key === "role")).toMatchObject({ label: "角色", before: "ops", after: "finance", changed: true })
    expect(rows.find((r) => r.key === "status")).toMatchObject({ before: "active", after: "active", changed: false })
  })

  it("仅一侧存在的键：另一侧显示「—」且计为变更（新增字段）", () => {
    const rows = diffRows({ balance: 200 }, { amount: 10000, balance: 10200 })
    expect(rows.find((r) => r.key === "amount")).toMatchObject({ before: "—", after: "10000", changed: true })
    expect(rows.find((r) => r.key === "balance")).toMatchObject({ before: "200", after: "10200", changed: true })
  })

  it("布尔渲染是/否；null→—", () => {
    const rows = diffRows({}, { passwordReset: true, note: null })
    expect(rows.find((r) => r.key === "passwordReset")).toMatchObject({ label: "重置密码", before: "—", after: "是", changed: true })
    expect(rows.find((r) => r.key === "note")).toMatchObject({ after: "—", changed: false })
  })

  it("标量快照归到「值」行；两侧都空返回空数组", () => {
    expect(diffRows("旧", "新")).toEqual([{ key: "值", label: "值", before: "旧", after: "新", changed: true }])
    expect(diffRows(null, null)).toEqual([])
  })
})
