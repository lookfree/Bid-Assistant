"use client"

import { StandaloneBidEntry } from "@/components/tool/standalone-bid-entry"
import type { ProjectListItem } from "@/lib/project"

// bid-kind 可述标 = 已到 present 步及之后（present/export/done）：此时审查已完成、后端述标闸放行。
// currentStep='review'（正文刚生成、审查未跑）时后端 present 步会 409（projects.ts 步序闸），若列入则
// 选中后 stepPrereq 判未就绪、空转回入口，故排除。线下标书（kind='review'）不受此限，由 isSelectable
// 的 kind==='review' 分支始终放行（后端 presentIndependent 同步放行）。
const GENERATED_STEPS = ["present", "export", "done"]

/** 述标独立入口（spec328+ 独立述标）：可述标 = bid-kind 已到 present 步及之后（审查已完成，见上方
 *  GENERATED_STEPS），或任意线下标书项目（review-kind，不依赖是否跑过审查/是否有招标文件——用户想述标就述标）。
 *  上传卡只传标书（bidOnly）：述标跑在独立线程、不吃招标上下文，故不必附招标文件、也不走 /read 绕路。 */
export function PresentEntry({ onBack }: { onBack?: () => void } = {}) {
  return (
    <StandaloneBidEntry
      onBack={onBack}
      backLabel="← 返回当前项目的述标"
      noTenderHref="/present?view=project"
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
