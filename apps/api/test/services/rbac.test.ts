import { describe, it, expect } from "bun:test"
import { ROLE_PERMISSIONS, hasPermission } from "../../src/services/rbac"

describe("spec309 RBAC 角色→权限", () => {
  it("superadmin 拥有全部权限", () => {
    expect(hasPermission("superadmin", "refund.write")).toBe(true)
    expect(hasPermission("superadmin", "config.write")).toBe(true)
    expect(hasPermission("superadmin", "credit.adjust")).toBe(true)
  })

  it("finance 管订单/退款，不能改套餐/调用户", () => {
    expect(hasPermission("finance", "order.read")).toBe(true)
    expect(hasPermission("finance", "refund.write")).toBe(true)
    expect(hasPermission("finance", "plan.write")).toBe(false)
    expect(hasPermission("finance", "user.write")).toBe(false)
  })

  it("ops 管用户/套餐，不能退款", () => {
    expect(hasPermission("ops", "user.write")).toBe(true)
    expect(hasPermission("ops", "plan.write")).toBe(true)
    expect(hasPermission("ops", "refund.write")).toBe(false)
  })

  it("support 只读，唯一例外是 feedback.write（客服处理工单，spec326）", () => {
    expect(hasPermission("support", "user.read")).toBe(true)
    expect(hasPermission("support", "order.read")).toBe(true)
    expect(hasPermission("support", "user.write")).toBe(false)
    expect(hasPermission("support", "refund.write")).toBe(false)
    expect(hasPermission("support", "credit.adjust")).toBe(false)
    expect(hasPermission("support", "feedback.write")).toBe(true)
    expect(hasPermission("finance", "feedback.write")).toBe(false) // finance 不加（brief 明示）
  })

  it("admin.manage 仅 superadmin", () => {
    expect(hasPermission("superadmin", "admin.manage")).toBe(true)
    expect(hasPermission("ops", "admin.manage")).toBe(false)
    expect(hasPermission("finance", "admin.manage")).toBe(false)
    expect(hasPermission("support", "admin.manage")).toBe(false)
  })

  it("每个角色都有权限集定义", () => {
    for (const role of ["superadmin", "ops", "finance", "support"] as const) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true)
    }
  })
})
