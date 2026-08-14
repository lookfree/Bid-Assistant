import { legacyDocAdvice } from "@/lib/files"

/** .doc 另存建议的统一渲染（文案+配色单点，选中文件里有 .doc 才出现，绝不拦截）。
 *  2026-08-14 code-review 实证：此前四行 IIFE 逐处手贴，一处贴进了永远不可达的空状态
 *  分支（制作上传页）、一处 .doc 入口整个漏掉（查重上传）——手贴机制本身就是缺陷来源，
 *  单点组件让新增上传入口只需挂一行。间距/字号由调用处按版面传入。 */
export function LegacyDocAdvice({ names, className }: {
  names: Array<string | null | undefined>
  className?: string
}) {
  const advice = legacyDocAdvice(names)
  if (!advice) return null
  return <p className={`font-medium text-amber-600 dark:text-amber-500 ${className ?? ""}`}>{advice}</p>
}
