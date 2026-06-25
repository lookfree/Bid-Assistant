import { AlertTriangle } from "lucide-react"

/* 灰色骨架占位条 */
function Bar({ w = "w-full", tone = "bg-muted" }: { w?: string; tone?: string }) {
  return <span className={`block h-2 rounded-full ${tone} ${w}`} />
}

/* 左栏目录单行 */
function NavRow({
  dot,
  w,
  active = false,
  label,
}: {
  dot: string
  w: string
  active?: boolean
  label?: string
}) {
  if (active) {
    return (
      <div className="relative flex items-center gap-2 rounded-md gradient-brand-soft py-1.5 pl-3 pr-2">
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="truncate text-[10px] font-medium text-primary">{label}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 py-1.5 pl-3 pr-2">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <Bar w={w} />
    </div>
  )
}

/**
 * 仿真产品界面预览：标书生成三栏工作台
 * 纯 HTML/CSS，使用项目红白设计令牌，配色随主题自动跟随。装饰性，aria-hidden。
 */
export function HeroMock() {
  return (
    <div aria-hidden className="relative">
      <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl rotate-[-0.6deg]">
        {/* 仿窗口栏 */}
        <div className="flex items-center justify-between gap-2 border-b border-border bg-secondary/60 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-md gradient-brand text-[9px] font-bold text-white">
              智
            </span>
            <span className="text-[11px] font-semibold text-foreground">智启元 · 投标助手</span>
          </div>
          <div className="hidden items-center gap-1 sm:flex">
            <span className="rounded-full gradient-brand px-2 py-0.5 text-[10px] font-medium text-white">技术标</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] text-muted-foreground">商务标</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] text-muted-foreground">标书全文</span>
          </div>
          <span className="rounded-md gradient-brand px-2.5 py-1 text-[10px] font-medium text-white">导出</span>
        </div>

        {/* 三栏 */}
        <div className="grid grid-cols-[110px_1fr] lg:grid-cols-[120px_1fr_150px]">
          {/* 左栏：目录 */}
          <div className="border-r border-border py-2">
            <p className="px-3 pb-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">目录</p>
            <NavRow active label="第一章 项目理解与整体方案" dot="" w="" />
            <NavRow dot="bg-border" w="w-16" />
            <NavRow dot="bg-border" w="w-20" />
            <NavRow dot="bg-warning" w="w-14" />
            <NavRow dot="bg-border" w="w-16" />
          </div>

          {/* 中栏：正文 */}
          <div className="border-r-0 px-4 py-3 lg:border-r lg:border-border">
            <p className="text-[11px] font-semibold text-foreground">第一章 项目理解与整体方案</p>
            <div className="mt-3 flex flex-col gap-2.5">
              <Bar w="w-[92%]" />
              <span className="block h-2 w-[68%] rounded-full bg-muted [border-bottom:2px_solid_var(--primary)]" />
              <Bar w="w-[85%]" />
              <Bar w="w-[96%]" />
              <span className="block h-2 w-[54%] rounded-full bg-muted [border-bottom:2px_solid_var(--primary)]" />
              <Bar w="w-[78%]" />
            </div>
          </div>

          {/* 右栏：AI 助手（小屏隐藏） */}
          <div className="hidden flex-col py-3 lg:flex">
            <p className="px-3 pb-2 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              智启元 · 投标助手
            </p>
            <div className="flex flex-col gap-2 px-3">
              {/* AI 气泡 */}
              <div className="max-w-[88%] rounded-lg rounded-tl-sm border border-border bg-secondary/60 p-2">
                <div className="flex flex-col gap-1.5">
                  <Bar w="w-full" />
                  <Bar w="w-3/4" />
                </div>
              </div>
              {/* 用户气泡 */}
              <div className="ml-auto max-w-[80%] rounded-lg rounded-tr-sm gradient-brand p-2">
                <div className="flex flex-col gap-1.5">
                  <span className="block h-2 w-full rounded-full bg-white/45" />
                  <span className="block h-2 w-2/3 rounded-full bg-white/45" />
                </div>
              </div>
            </div>
            {/* 快捷指令 */}
            <div className="mt-auto flex flex-wrap gap-1 px-3 pt-3">
              <span className="rounded-full border border-border px-2 py-0.5 text-[9px] text-muted-foreground">
                扩写本章
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[9px] text-muted-foreground">
                更正式
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 点睛浮层：废标体检 */}
      <div className="absolute -bottom-4 -right-2 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg sm:-right-4">
        <AlertTriangle className="size-4 text-primary" />
        <span className="text-[11px] text-foreground">
          废标体检 · 健康分 <span className="font-semibold">78</span> ·{" "}
          <span className="font-semibold text-primary">1 项高风险</span>
        </span>
      </div>
    </div>
  )
}
