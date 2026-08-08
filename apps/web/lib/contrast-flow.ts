/** 对照审查：读完招标文件之后该干什么。
 *
 *  抽成纯函数是为了能测——这条分支错了代价很不对称：
 *  多包件漏了选包，会拿其它包件的★要求去判本包的标书，报出一堆并不存在的废标风险；
 *  单包件却停下来问，等于白白多打断用户一次。 */
export function nextContrastPhase(packageCount: number): "pick" | "review" {
  return packageCount > 1 ? "pick" : "review"
}

/** 这次失败该不该转轮询收敛，而不是报给用户看。
 *
 *  读标要 2–5 分钟，代理/网络掐断 SSE 是常事，而 run 仍在服务端跑或已跑完。
 *  照直报"生成失败"，用户会对着一次**已经扣过费**的成功重试，再点还会撞 409。 */
export function shouldConverge(kind: "stream-incomplete" | "already-running" | "already-done" | "other"): boolean {
  return kind !== "other"
}

/** 读标已有结果时**不能重跑**：要么再扣一次 20 积分，要么被步序闸 409 拒死
 *  （读标跑完 currentStep 就推进到 review，再 POST read 就是 out_of_order）。 */
export function needsRead(hasReadResult: boolean): boolean {
  return !hasReadResult
}
