export class InsufficientCreditsError extends Error {
  constructor(
    public needed: number,
    public available: number,
  ) {
    super(`积分不足：需 ${needed}，可用 ${available}`)
    this.name = "InsufficientCreditsError"
  }
}
