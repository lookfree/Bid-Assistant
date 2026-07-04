// 金额换算（钱相关：DB 存整数分，禁浮点存储；对外展示才转元）。
// 分→元：整数分 /100 至多两位小数，无精度损失。元→分：四舍五入到整数分。
export function centsToYuan(cents: number): number {
  return Math.round(cents) / 100
}
export function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100)
}
