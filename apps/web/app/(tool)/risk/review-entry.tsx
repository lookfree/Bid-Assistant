"use client"

import { StandaloneBidEntry } from "@/components/tool/standalone-bid-entry"
import { reviewable } from "@/lib/bid-pick"

/** 标书审查独立入口（spec328）：可审查 = 同时有招标文件与投标文件（见 lib/bid-pick 的 reviewable）。onBack：从「当前项目审查」切过来时给返回入口
 *  （用户反馈：废标 tab 也要能直达上传,否则只有查重 tab 见得到上传,被误解为只有查重支持传标书）。 */
export function ReviewEntry({ onBack }: { onBack?: () => void } = {}) {
  return (
    <StandaloneBidEntry
      onBack={onBack}
      backLabel="← 返回当前项目的审查"
      noTenderHref="/risk?view=project"
      pickTitle="审查我的标书"
      pickDesc="选择已生成正文、且有招标文件的项目（废标体检要逐条比对招标要求，两者缺一不可）"
      emptyHint="暂无可直接体检的标书（需同时有招标文件与投标文件），可在下方上传后审查"
      isSelectable={reviewable}
      switchToUploadLabel="没有合适的项目？改为上传线下标书 + 对应招标文件"
      doneStep="review"
      doneLabel="已审查 · 可重跑"
      readyLabel="可审查"
      uploadTitle="审查线下标书"
      uploadDesc="上传线下制作的投标文件与对应招标文件，逐条对照做废标体检（两者一体，缺一不可）"
      tenderHint="（必选，用于逐条对照）"
      tenderRequired
      submitLabel="创建对照审查（先读标）"
    />
  )
}
