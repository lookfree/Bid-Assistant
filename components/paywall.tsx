"use client"

import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import Link from "next/link"
import { X, Check, Lock, Sparkles, Crown, Zap, ListTree, FileDown, Presentation } from "lucide-react"
import { useEscapeClose } from "@/hooks/use-escape-close"

export type PaywallScene = "export" | "present"

type SceneConfig = {
  icon: typeof ListTree
  badge: string
  title: string
  subtitle: string
  unlocked: string[]
  locked: string[]
}

const sceneConfig: Record<PaywallScene, SceneConfig> = {
  export: {
    icon: FileDown,
    badge: "继续导出",
    title: "积分不足，无法导出",
    subtitle: "标书已生成完成，导出 Word / PDF 消耗积分；当前积分不足，充值或开通会员后即可继续导出",
    unlocked: ["完整正文预览", "在线编辑与排版", "风险问题清单"],
    locked: ["导出 Word / PDF", "完整风险体检", "投标包附件清单", "历史版本长期保存"],
  },
  present: {
    icon: Presentation,
    badge: "继续述标",
    title: "积分不足，无法导出",
    subtitle: "述标大纲已生成，导出述标 PPT 消耗积分；当前积分不足，充值或开通会员后即可继续导出",
    unlocked: ["述标大纲生成", "每页要点预览", "模板风格切换"],
    locked: ["导出 PPTX / PDF", "完整演讲稿与口播", "评委预计问答", "演讲备注同步导出"],
  },
}

type PaywallContextValue = {
  openPaywall: (scene: PaywallScene) => void
  closePaywall: () => void
}

const PaywallContext = createContext<PaywallContextValue | null>(null)

export function usePaywall() {
  const ctx = useContext(PaywallContext)
  if (!ctx) throw new Error("usePaywall 必须在 PaywallProvider 内使用")
  return ctx
}

export function PaywallProvider({ children }: { children: ReactNode }) {
  const [scene, setScene] = useState<PaywallScene | null>(null)

  const openPaywall = useCallback((s: PaywallScene) => setScene(s), [])
  const closePaywall = useCallback(() => setScene(null), [])
  useEscapeClose(closePaywall, scene !== null)

  const config = scene ? sceneConfig[scene] : null
  const SceneIcon = config?.icon ?? ListTree

  return (
    <PaywallContext.Provider value={{ openPaywall, closePaywall }}>
      {children}
      {config && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={closePaywall} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={config.title}
            className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          >
            <button
              onClick={closePaywall}
              className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>

            {/* 头部 */}
            <div className="px-7 pb-5 pt-7">
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <SceneIcon className="size-5" />
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
                  <Sparkles className="size-3.5" />
                  {config.badge}
                </span>
              </div>
              <h2 className="mt-4 text-xl font-bold leading-snug text-foreground text-balance">{config.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{config.subtitle}</p>
            </div>

            {/* 权益对比 */}
            <div className="grid gap-3 px-7 sm:grid-cols-2">
              {/* 当前已解锁 */}
              <div className="rounded-xl border border-border bg-muted/40 p-4">
                <p className="text-xs font-medium text-muted-foreground">当前已解锁</p>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {config.unlocked.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-sm text-foreground">
                      <Check className="size-4 shrink-0 text-success" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              {/* 充值或开通后可继续 */}
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                <p className="flex items-center gap-1 text-xs font-medium text-primary">
                  <Sparkles className="size-3.5" />
                  充值或开通后可继续
                </p>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {config.locked.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Lock className="size-3.5 shrink-0 text-primary" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* 按钮区 */}
            <div className="flex flex-col gap-2.5 px-7 pb-4 pt-6">
              <Link
                href={`/login?reason=${encodeURIComponent("登录后即可开通会员并继续当前操作")}`}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Crown className="size-4" />
                开通会员
              </Link>
              <Link
                href={`/login?reason=${encodeURIComponent("登录后即可充值积分并继续当前操作")}`}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Zap className="size-4 text-primary" />
                充值积分
              </Link>
            </div>

            {/* 底部 */}
            <div className="flex items-center justify-between border-t border-border px-7 py-3.5">
              <Link href="/membership" className="text-xs font-medium text-primary hover:underline">
                查看完整套餐对比
              </Link>
              <button
                onClick={closePaywall}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      )}
    </PaywallContext.Provider>
  )
}
