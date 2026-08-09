"use client"

// 「资格证明文件」附录章过期提示条（2026-08-09 附录系统章节 Task 5）：资料库资质图片有增删
// 而附录章仍是上一次生成/刷新时的旧快照时出现，一键免费重建（不重新生成整份正文）。
export function CredentialsAppendixBanner({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning-foreground">
      <span>资料库资质已更新，本附录仍是生成时的旧快照</span>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="shrink-0 rounded-lg border border-warning/40 px-2.5 py-1 font-semibold disabled:opacity-50"
      >
        {refreshing ? "刷新中…" : "刷新附录"}
      </button>
    </div>
  )
}
