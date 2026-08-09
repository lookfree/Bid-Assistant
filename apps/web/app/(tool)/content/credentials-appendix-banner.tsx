"use client"

// 「资格证明文件」附录章过期提示条（2026-08-09 附录系统章节 Task 5）：资料库资质图片有增删
// 而附录章仍是上一次生成/刷新时的旧快照时出现，一键免费重建（不重新生成整份正文）。
//
// no-credentials 变体（终审 I1）：刷新遇 409 no_credentials（资料库资质条目已清零）——重试
// 解决不了，不给「刷新附录」按钮，改成一次性提示 + 手动删附录章的引导，点「知道了」收起。
export function CredentialsAppendixBanner(
  props:
    | { variant: "stale"; refreshing: boolean; onRefresh: () => void }
    | { variant: "no-credentials"; onDismiss: () => void },
) {
  const body =
    props.variant === "stale"
      ? {
          text: "资料库资质已更新，本附录仍是生成时的旧快照",
          action: props.refreshing ? "刷新中…" : "刷新附录",
          onClick: props.onRefresh,
          disabled: props.refreshing,
        }
      : { text: "资料库已无资质条目，可手动删除附录章", action: "知道了", onClick: props.onDismiss, disabled: false }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning-foreground">
      <span>{body.text}</span>
      <button
        onClick={body.onClick}
        disabled={body.disabled}
        className="shrink-0 rounded-lg border border-warning/40 px-2.5 py-1 font-semibold disabled:opacity-50"
      >
        {body.action}
      </button>
    </div>
  )
}
