"use client"

/** 多包件招标的选包卡（spec324）。
 *
 *  从读标页抽出来共享：废标风险审查那条独立入口同样要选包——不选就会拿**所有包**的★要求
 *  去比对**单包**的投标文件，别的包的要求全被误报成「未响应」。线上 53 个读过标的项目里
 *  21 个是多包件（39%），不是边缘情况。抽出来是为了两处用同一个卡，不是各写一份后漂移。 */
import { Boxes, Check, Loader2 } from "lucide-react"

import type { PackageInfo } from "@/lib/bid-types"

export function PackageSelector({
  packages,
  takenIds,
  cloneCandidates,
  selectedId,
  saving,
  message,
  error,
  onSelect,
  onClone,
  cloning,
  cloneError,
}: {
  packages: PackageInfo[]
  takenIds: string[]
  cloneCandidates: PackageInfo[]
  selectedId: string | null
  saving: boolean
  message: string | null
  error: string | null
  onSelect: (pkg: PackageInfo) => void
  onClone: (pkg: PackageInfo) => void
  cloning: boolean
  cloneError: string | null
}) {
  return (
    <section className="mt-5 rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <Boxes className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-semibold text-foreground">选择投标包件</span>
        <span className="ml-auto text-xs text-muted-foreground">多包件招标须先选包才能生成大纲，一次只能投一个包</span>
      </header>
      <div className="flex flex-col gap-2 px-4 py-4">
        {packages.map((pkg) => {
          const selected = selectedId === pkg.id
          const taken = !selected && takenIds.includes(pkg.id)
          return (
            <button
              key={pkg.id}
              onClick={() => !taken && onSelect(pkg)}
              disabled={saving || taken}
              className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-primary/50 gradient-brand-soft"
                  : taken
                    ? "cursor-not-allowed border-border bg-muted/40"
                    : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                  {pkg.name}
                  {pkg.budget && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {pkg.budget}
                    </span>
                  )}
                  {taken && (
                    <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                      已生成大纲（其它项目）
                    </span>
                  )}
                </span>
                {pkg.notes && <span className="mt-1 block text-xs text-muted-foreground">{pkg.notes}</span>}
              </span>
              {selected ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : taken ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success/60" />
              ) : (
                <span className="mt-0.5 size-4 shrink-0 rounded-full border border-border" />
              )}
            </button>
          )
        })}
        {message && <p className="text-xs font-medium text-success">{message}</p>}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">兼投多包件需分开制作投标文件——选要再投的包，新建一个项目：</p>
        {cloneCandidates.length === 0 ? (
          <span className="text-xs text-muted-foreground">所有包件均已生成大纲，无可再投的包</span>
        ) : (
          cloneCandidates.map((pkg) => (
            <button
              key={pkg.id}
              onClick={() => onClone(pkg)}
              disabled={cloning}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
            >
              {cloning && <Loader2 className="size-3.5 animate-spin" />}
              再投「{pkg.name}」
            </button>
          ))
        )}
      </div>
      {cloneError && <p className="px-4 pb-3 text-xs font-medium text-destructive">{cloneError}</p>}
    </section>
  )
}
