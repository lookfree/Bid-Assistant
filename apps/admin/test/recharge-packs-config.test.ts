import { describe, expect, it } from "bun:test"
import {
  toRechargeRows,
  toRechargeConfig,
  unitPricePer100,
  validateRechargeRows,
  type RechargePackRow,
} from "@/lib/recharge-packs-config"

const row = (p: Partial<RechargePackRow> = {}): RechargePackRow => ({ id: "pack_1", amountYuan: 10, credits: 1100, ...p })

describe("配置 ↔ 编辑行互转", () => {
  it("分/元换算往返一致；坏形状不炸", () => {
    const cfg = { recharge_packs: [{ id: "pack_100", amountCents: 100, credits: 100 }, { id: "pack_1000", amountCents: 1000, credits: 1100 }] }
    const rows = toRechargeRows(cfg)
    expect(rows).toEqual([
      { id: "pack_100", amountYuan: 1, credits: 100 },
      { id: "pack_1000", amountYuan: 10, credits: 1100 },
    ])
    expect(toRechargeConfig(rows)).toEqual(cfg.recharge_packs)
    expect(toRechargeRows({})).toEqual([])
    expect(toRechargeRows({ recharge_packs: "坏值" })).toEqual([])
  })

  it("元→分四舍五入到分：浮点直乘会得到 9.999…（0.1 元这类输入）", () => {
    expect(toRechargeConfig([row({ amountYuan: 0.1 })])[0]!.amountCents).toBe(10)
    expect(toRechargeConfig([row({ amountYuan: 29.99 })])[0]!.amountCents).toBe(2999)
  })
})

describe("单价（C 端展示同源）", () => {
  it("按金额/积分实时算，非法值给 null 而不是 NaN/Infinity", () => {
    expect(unitPricePer100(row({ amountYuan: 10, credits: 1100 }))).toBeCloseTo(0.909, 3)
    expect(unitPricePer100(row({ credits: 0 }))).toBeNull()
    expect(unitPricePer100(row({ amountYuan: 0 }))).toBeNull()
  })
})

describe("校验（须为服务端 zod 的同集或更严）", () => {
  it("合法配置无错", () => {
    expect(validateRechargeRows([row(), row({ id: "pack_2", amountYuan: 50, credits: 6000 })]).errors).toEqual({})
  })
  it("空 id / 重复 id 报在对应行", () => {
    const { errors } = validateRechargeRows([row({ id: "" }), row({ id: "dup" }), row({ id: "dup" })])
    expect(errors[0]?.id).toContain("不能为空")
    expect(errors[2]?.id).toContain("第 2 行")
  })
  it("金额/积分必须为正；换算成分后为 0 的金额同样拒（下单必被通道拒）", () => {
    expect(validateRechargeRows([row({ amountYuan: 0 })]).errors[0]?.amountYuan).toBeTruthy()
    expect(validateRechargeRows([row({ amountYuan: 0.001 })]).errors[0]?.amountYuan).toBeTruthy()
    expect(validateRechargeRows([row({ credits: 0 })]).errors[0]?.credits).toBeTruthy()
    expect(validateRechargeRows([row({ credits: 1.5 })]).errors[0]?.credits).toBeTruthy()
  })
  it("一个档位都不留 → 整表报错（否则 C 端充值区空白）", () => {
    expect(validateRechargeRows([]).formError).toBeTruthy()
  })
})
