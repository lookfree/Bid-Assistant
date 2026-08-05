// 订单枚举 → 中文，以及金额分→元。**只服务于服务端产出的报错文案**：
// 这类文案是整句自由文本、前端无法按码映射，必须在这里就说人话。
// （前端按错误码出文案的场景一律走 admin-labels.ts，不要把那套搬过来。）
//
// 由来：运营在后台点退款，看到的是「renewal 单不支持自动退款」「订单状态非 paid：created」
// 「已退/在途 1000 + 本次 3900」——枚举名是英文、金额是分，运营读不懂也没法据此决定下一步。

const ORDER_STATUS_CN: Record<string, string> = {
  created: "待支付",
  paid: "已支付",
  failed: "支付失败",
  unknown: "支付结果待核对",
  refunded: "已退款",
}

const ORDER_TYPE_CN: Record<string, string> = {
  recharge: "积分充值",
  // 本产品不做自动续费/代扣（架构 §6.2 是到期提醒 + 手动续费），故不叫「自动续费」。
  renewal: "会员开通/续费",
  purchase: "单笔购买",
}

/** 未知取值原样回显（而不是显示"未知"）：真出现库外取值时，运营看到原文才报得清。 */
export const orderStatusCn = (s: string): string => ORDER_STATUS_CN[s] ?? s
export const orderTypeCn = (t: string): string => ORDER_TYPE_CN[t] ?? t

/** 分 → 元，供报错文案里的金额展示（运营口径是元，库里存分）。 */
export const yuan = (cents: number): string => `¥${(cents / 100).toFixed(2)}`
