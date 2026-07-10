import { getConfigs, pickPositive } from "./config"

// run_input.rag 下发（spec316）：agent 节点从 run_input.rag 读配置、按 user_id 隔离检索。
// 纯解析函数（本机可测，无需真库）：enabled 默认 true（仅显式 false 才关闭），top_k 缺失/非正数兜底 3。
export function parseRagRunInput(cfgs: Record<string, unknown>): { enabled: boolean; top_k: number } {
  return { enabled: cfgs["rag.enabled"] !== false, top_k: pickPositive(cfgs["rag.top_k"], 3) }
}

// 每个 run 调用：读 billing_configs 的 rag.* 前缀，供调用方并入 input.run_input。
export async function ragRunInput(): Promise<{ enabled: boolean; top_k: number }> {
  return parseRagRunInput(await getConfigs("rag."))
}
