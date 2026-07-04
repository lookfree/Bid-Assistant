import { test, expect } from "bun:test"
import { BILLING_SEED } from "../src/config/billing-seed"

test("BILLING_SEED 含 agent_model 默认（deepseek / 空模型 / 空兜底）", () => {
  expect(BILLING_SEED.agent_model).toEqual({ provider: "deepseek", model: null, fallbacks: "" })
})
