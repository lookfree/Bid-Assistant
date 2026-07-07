// risk 页三个 tab（废标审查 / 查重 / 审核表）共用的 tone → 样式映射。

export type ToneClass = { badge: string; icon: string; border: string }

export const toneClasses: Record<string, ToneClass> = {
  destructive: {
    badge: "bg-destructive/10 text-destructive",
    icon: "text-destructive",
    border: "border-destructive/30",
  },
  warning: { badge: "bg-warning/15 text-warning-foreground", icon: "text-warning", border: "border-warning/30" },
  success: { badge: "bg-success/10 text-success", icon: "text-success", border: "border-success/30" },
}

/** 容错取样式：后端 tone 超出枚举时按 warning 展示，避免渲染崩。 */
export function toneClass(tone: string): ToneClass {
  return toneClasses[tone] ?? toneClasses.warning!
}
