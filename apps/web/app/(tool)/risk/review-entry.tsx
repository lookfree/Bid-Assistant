"use client"

import { StandaloneBidEntry } from "@/components/tool/standalone-bid-entry"
import type { ProjectListItem } from "@/lib/project"

const SELECTABLE_STEPS = ["review", "present", "export", "done"]

/** 标书审查独立入口（spec328）：可审查=正文已生成（走到 review 及之后），
 *  含已完成的审查专用项目（重看报告）。onBack：从「当前项目审查」切过来时给返回入口
 *  （用户反馈：废标 tab 也要能直达上传,否则只有查重 tab 见得到上传,被误解为只有查重支持传标书）。 */
export function ReviewEntry({ onBack }: { onBack?: () => void } = {}) {
  return (
    <StandaloneBidEntry
      onBack={onBack}
      backLabel="← 返回当前项目的审查"
      noTenderHref="/risk"
      pickTitle="审查我的标书"
      pickDesc="选择已生成正文的项目，进入废标体检"
      emptyHint="暂无已生成正文的标书，可先上传线下标书审查"
      isSelectable={(p: ProjectListItem) => SELECTABLE_STEPS.includes(p.currentStep)}
      readyLabel="可审查"
      uploadTitle="审查线下标书"
      uploadDesc="上传线下制作的投标文件进行废标体检；附上对应招标文件可做逐条对照审查（更准），否则做通用自查"
      tenderHint="（可选，附上可做对照审查）"
      submitLabel="创建审查"
      submitLabelWithTender="创建对照审查（先读标）"
    />
  )
}
