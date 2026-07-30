"use client"

import { StandaloneBidEntry } from "@/components/tool/standalone-bid-entry"
import { presentable } from "@/lib/bid-pick"

/** 述标独立入口（spec328+ 独立述标）：可述标 = 手里确实有一份投标文件（见 lib/bid-pick 的 presentable）。
 *  上传卡只传标书（bidOnly）：述标跑在独立线程、不吃招标上下文，故不必附招标文件、也不走 /read 绕路。 */
export function PresentEntry({ onBack }: { onBack?: () => void } = {}) {
  return (
    <StandaloneBidEntry
      onBack={onBack}
      backLabel="← 返回当前项目的述标"
      noTenderHref="/present?view=project"
      pickTitle="述标我的标书"
      pickDesc="选择已有投标文件的项目（已生成正文的项目，或上传的线下标书）"
      emptyHint="暂无可直接述标的标书，可先上传线下标书述标"
      isSelectable={presentable}
      switchToUploadLabel="没有可用的标书？改为上传线下标书"
      doneStep="present"
      doneLabel="已述标 · 可重跑"
      readyLabel="可述标"
      uploadTitle="述标线下标书"
      uploadDesc="上传线下制作的投标文件，一键生成述标/答辩 PPT（含演讲备注与预计问答）"
      bidOnly
      submitLabel="创建述标"
    />
  )
}
