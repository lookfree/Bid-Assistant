"use client"

import { StandaloneBidEntry } from "@/components/tool/standalone-bid-entry"
import type { ProjectListItem } from "@/lib/project"

const GENERATED_STEPS = ["review", "present", "export", "done"] // bid-kind：正文已生成（走到 review 及之后）

/** 述标独立入口（spec328+ 独立述标）：可述标 = 系统标书已生成正文（bid-kind，走到 review 及之后），
 *  或任意线下标书项目（review-kind，不依赖是否跑过审查/是否有招标文件——用户想述标就述标）。
 *  上传卡只传标书（bidOnly）：述标跑在独立线程、不吃招标上下文，故不必附招标文件、也不走 /read 绕路。 */
export function PresentEntry({ onBack }: { onBack?: () => void } = {}) {
  return (
    <StandaloneBidEntry
      onBack={onBack}
      backLabel="← 返回当前项目的述标"
      noTenderHref="/present"
      pickTitle="述标我的标书"
      pickDesc="选择已生成正文的项目，或线下标书，进入述标"
      emptyHint="暂无可直接述标的标书，可先上传线下标书述标"
      isSelectable={(p: ProjectListItem) => p.kind === "review" || GENERATED_STEPS.includes(p.currentStep)}
      readyLabel="可述标"
      uploadTitle="述标线下标书"
      uploadDesc="上传线下制作的投标文件，一键生成述标/答辩 PPT（含演讲备注与预计问答）"
      bidOnly
      submitLabel="创建述标"
    />
  )
}
