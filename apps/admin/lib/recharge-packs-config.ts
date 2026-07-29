// 充值档位配置的解析与校验（纯函数，与 UI 解耦便于测试）。
// 服务端权威校验见 apps/api routes/admin/plans.ts 的 CONFIG_SCHEMAS.recharge_packs——
// 这里的规则必须是它的**同集或更严**，否则前端放行的值会被后端 400，用户看不懂为什么保存不上。

export type RechargePackRow = {
  id: string
  /** 金额（元）：UI 用元编辑，提交时换算成分（后端存 amountCents，禁浮点） */
  amountYuan: number
  credits: number
}

/** 后台配置（分）→ 编辑行（元）。非数组/坏形状一律返回空列表，交由 UI 提示。 */
export function toRechargeRows(configs: Record<string, unknown>): RechargePackRow[] {
  const raw = configs["recharge_packs"]
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is { id: string; amountCents: number; credits: number } => !!p && typeof p === "object")
    .map((p) => ({ id: String(p.id ?? ""), amountYuan: Number(p.amountCents ?? 0) / 100, credits: Number(p.credits ?? 0) }))
}

/** 编辑行（元）→ 配置（分）。四舍五入到分：0.1 元这类输入用浮点直乘会得到 9.999…。 */
export function toRechargeConfig(rows: RechargePackRow[]): { id: string; amountCents: number; credits: number }[] {
  return rows.map((r) => ({ id: r.id.trim(), amountCents: Math.round(r.amountYuan * 100), credits: Math.round(r.credits) }))
}

/** 每 100 积分单价（元），用于让运营在保存前就看到 C 端会显示的单价文案。 */
export function unitPricePer100(row: RechargePackRow): number | null {
  if (!(row.credits > 0) || !(row.amountYuan > 0)) return null
  return (row.amountYuan / row.credits) * 100
}

export type RechargeErrors = Record<number, Partial<Record<"id" | "amountYuan" | "credits", string>>>

/** 逐行校验 + 跨行唯一性。返回 {行号: {字段: 文案}}，空对象=可保存。 */
export function validateRechargeRows(rows: RechargePackRow[]): { errors: RechargeErrors; formError?: string } {
  const errors: RechargeErrors = {}
  const seen = new Map<string, number>()
  rows.forEach((r, i) => {
    const e: RechargeErrors[number] = {}
    const id = r.id.trim()
    if (!id) e.id = "档位 id 不能为空"
    else if (seen.has(id)) e.id = `与第 ${seen.get(id)! + 1} 行重复`
    else seen.set(id, i)
    // 金额换算成分后必须是正整数：0.001 元这类输入四舍五入后成 0，下单必被通道拒
    if (!(Math.round(r.amountYuan * 100) > 0)) e.amountYuan = "金额必须大于 0"
    if (!Number.isInteger(r.credits) || r.credits <= 0) e.credits = "积分必须为正整数"
    if (Object.keys(e).length) errors[i] = e
  })
  return { errors, formError: rows.length === 0 ? "至少保留一个充值档位（否则 C 端充值区为空）" : undefined }
}
