import { describe, it, expect } from "bun:test"
import { visibleNav } from "../lib/admin-perms"

// 可编辑 RBAC（2026-08-02）：菜单绑权限点,角色没有的菜单不渲染。
const NAV = [
  { title: "概览看板", url: "/" },
  { title: "用户与会员", url: "/users", perm: "user.read" },
  { title: "订单与对账", url: "/orders", perm: "order.read" },
  { title: "发票管理", url: "/invoices", perm: "invoice.write" },
  { title: "标书分类纠偏", url: "/bid-categories", perm: "category.read" },
  { title: "系统与权限", url: "/system", perm: "admin.manage" },
]

describe("visibleNav：菜单按权限集过滤", () => {
  it("财务默认权限集：看不到用户与纠偏（QA 上报的两处），看得到订单/发票", () => {
    const finance = ["order.read", "refund.write", "ledger.read", "audit.read", "invoice.write"]
    expect(visibleNav(NAV, finance).map((i) => i.title)).toEqual(["概览看板", "订单与对账", "发票管理"])
  })

  it("运营默认权限集：看得到用户/纠偏，看不到发票/系统", () => {
    const ops = ["user.read", "user.write", "plan.write", "config.write", "ledger.read", "audit.read",
                 "feedback.read", "feedback.write", "category.read"]
    expect(visibleNav(NAV, ops).map((i) => i.title))
      .toEqual(["概览看板", "用户与会员", "标书分类纠偏"])
  })

  it("权限集未加载（null）：只显示无权限要求的项，不闪现越权入口", () => {
    expect(visibleNav(NAV, null).map((i) => i.title)).toEqual(["概览看板"])
  })
})
