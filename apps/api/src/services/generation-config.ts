import { getConfigs } from "./config"

// run_input 篇幅校准下发（评审修正）：超写校准系数是持续调优的运营参数,固化在 agent 代码里
// 每调一次就要发版（发版会打断在途长任务）——改走 billing_configs（generation.* 前缀）,
// 未配置不下发键,agent 用自身默认（当前 1.4）。
export function parseGenerationRunInput(cfgs: Record<string, unknown>): { overshoot_calibration?: number } {
  const v = Number(cfgs["generation.overshoot_calibration"])
  // 合法域 [1,3]：1=不校准,3 已是极端;越界/非数一律不下发（agent 侧还有同域夹取兜底）
  return Number.isFinite(v) && v >= 1 && v <= 3 ? { overshoot_calibration: v } : {}
}

/** content 步每 run 调用：读 billing_configs 的 generation.* 前缀，供并入 input.run_input。 */
export async function generationRunInput(): Promise<{ overshoot_calibration?: number }> {
  return parseGenerationRunInput(await getConfigs("generation."))
}
