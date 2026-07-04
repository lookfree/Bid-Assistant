import { test, expect } from "bun:test"
import { toAgentModelForm, fromAgentModelForm } from "../components/admin/plans/plans-client"

test("toAgentModelForm：null 模型规整为空串", () => {
  expect(toAgentModelForm({ provider: "deepseek", model: null, fallbacks: "" }))
    .toEqual({ provider: "deepseek", model: "", fallbacks: "" })
})

test("fromAgentModelForm：空模型回写 null", () => {
  expect(fromAgentModelForm({ provider: "qwen", model: "", fallbacks: "glm:glm-4-flash" }))
    .toEqual({ provider: "qwen", model: null, fallbacks: "glm:glm-4-flash" })
})
