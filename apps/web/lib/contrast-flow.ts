/** 对照审查：读完招标文件之后该干什么。
 *
 *  抽成纯函数是为了能测——这条分支错了代价很不对称：
 *  多包件漏了选包，会拿其它包件的★要求去判本包的标书，报出一堆并不存在的废标风险；
 *  单包件却停下来问，等于白白多打断用户一次。 */
export function nextContrastPhase(packageCount: number): "pick" | "review" {
  return packageCount > 1 ? "pick" : "review"
}
