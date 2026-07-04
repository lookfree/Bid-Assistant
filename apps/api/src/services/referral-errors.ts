export class DuplicateInviteeError extends Error {
  constructor(public inviteeId: string) {
    super(`被邀请人已绑定邀请关系：${inviteeId}`)
    this.name = "DuplicateInviteeError"
  }
}
export class SelfReferralError extends Error {
  constructor() {
    super("不能使用自己的邀请码")
    this.name = "SelfReferralError"
  }
}
export class InvalidCodeError extends Error {
  constructor(public code: string) {
    super(`无效邀请码：${code}`)
    this.name = "InvalidCodeError"
  }
}
