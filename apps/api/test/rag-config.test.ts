import { test, expect } from "bun:test"
import { parseRagRunInput } from "../src/services/rag-config"

// 纯解析逻辑（无需真库）：configs 有值透传；缺失兜默认 {enabled:true, top_k:3}；
// rag.enabled=false 是唯一关闭途径（其余任何值都当未关闭处理）。

test("configs 有值 → 原样透传 {enabled, top_k}", () => {
  expect(parseRagRunInput({ "rag.enabled": true, "rag.top_k": 5 })).toEqual({ enabled: true, top_k: 5 })
})

test("configs 缺失 → 默认 {enabled:true, top_k:3}", () => {
  expect(parseRagRunInput({})).toEqual({ enabled: true, top_k: 3 })
})

test("rag.enabled=false → enabled:false", () => {
  expect(parseRagRunInput({ "rag.enabled": false })).toEqual({ enabled: false, top_k: 3 })
})

test("rag.top_k 非正数/非法值 → 兜底默认 3", () => {
  expect(parseRagRunInput({ "rag.top_k": 0 })).toEqual({ enabled: true, top_k: 3 })
  expect(parseRagRunInput({ "rag.top_k": -1 })).toEqual({ enabled: true, top_k: 3 })
  expect(parseRagRunInput({ "rag.top_k": "5" })).toEqual({ enabled: true, top_k: 3 })
})
