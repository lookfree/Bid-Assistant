import Link from "next/link"
import { Lock } from "lucide-react"

/** 整改建议解锁引导（体检摘要/完整报告/标书审查页三个面共用,文案与跳转一处定义防漂移）。
 *  advice 的可见性由服务端决定（非会员 items[].advice 裁剪不下发 + adviceLocked 标志,
 *  评审修正:此前全量下发靠前端模糊遮挡,F12 可读,且三个面一锁两不锁自相矛盾）。 */
export function AdviceLockHint({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/membership"
      className={`inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-opacity hover:opacity-80 ${className}`}
    >
      <Lock className="size-3" />
      开通会员查看完整整改建议
    </Link>
  )
}
