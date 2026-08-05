// 运营侧的用户展示名：优先昵称，否则打码手机号，都没有才回落 id。
// 账本页的用户选择器与账本列表（全部用户视图）必须用同一套口径，否则同一个人在下拉里
// 显示昵称、在列表里显示手机号，运营对不上是谁。

export function maskPhone(phone?: string | null): string {
  if (!phone) return ""
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone
}

export function userDisplayName(u: { id: string; nickname?: string | null; phone?: string | null }): string {
  return u.nickname || maskPhone(u.phone) || u.id
}
