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
    expect(rows.find((r) => r.key === "role")).toMatchObject({ label: "角色", before: "运营", after: "财务", changed: true })
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

describe("fmtVal（经 diffRows 观察）：套餐 features 中文化（QA：生 JSON 运营看不懂）", () => {
  it("全布尔对象 → 中文键 + 开/关；变更行照常标 changed", () => {
    const rows = diffRows(
      { features: { dedupe: true, export: true } },
      { features: { dedupe: false, export: true } },
    )
    const f = rows.find((r) => r.key === "features")!
    expect(f.before).toBe("标书查重:开、导出 Word/PDF:开")
    expect(f.after).toBe("标书查重:关、导出 Word/PDF:开")
    expect(f.changed).toBe(true)
  })
  it("未知键回退原键名；非纯布尔对象仍走 JSON", () => {
    const rows = diffRows({ features: { newThing: true } }, { limits: { max: 3 } })
    expect(rows.find((r) => r.key === "features")!.before).toBe("newThing:开")
    expect(rows.find((r) => r.key === "limits")!.after).toBe('{"max":3}')
  })
})

describe("审计对照中文化：角色键与权限数组（QA：不要英文关键字）", () => {
  it("RBAC 矩阵审计：角色键→中文标签,权限数组→中文顿号相连", () => {
    const rows = diffRows(
      { finance: ["order.read", "ledger.read"] },
      { finance: ["order.read", "ledger.read", "user.read"] },
    )
    const f = rows[0]!
    expect(f.label).toBe("财务角色权限")
    expect(f.before).toBe("查看订单、查看积分账本")
    expect(f.after).toBe("查看订单、查看积分账本、查看用户")
  })
  it("空数组显示（无）,未知字符串回退原文", () => {
    const rows = diffRows({ support: [] }, { support: ["mystery.perm"] })
    expect(rows[0]!.before).toBe("（无）")
    expect(rows[0]!.after).toBe("mystery.perm")
  })
})

describe("role 字段值中文化", () => {
  it("ops → 运营；未知值回退原文", () => {
    const rows = diffRows({ role: "ops" }, { role: "finance" })
    expect(rows[0]!.before).toBe("运营")
    expect(rows[0]!.after).toBe("财务")
  })
})
