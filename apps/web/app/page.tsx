import Link from "next/link"
import { HeroMock } from "@/components/hero-mock"
import { HomeAuthNav } from "@/components/home-auth-nav"
import {
  Sparkles,
  ArrowRight,
  Upload,
  FileSearch,
  ListTree,
  PenLine,
  ShieldCheck,
  Presentation,
  ShieldAlert,
  Target,
  ClipboardCheck,
  Library,
  CheckCircle2,
  User,
  Users,
  Briefcase,
} from "lucide-react"

const flow = [
  { icon: Upload, title: "上传招标文件", desc: "支持 PDF / Word，秒级解析" },
  { icon: FileSearch, title: "智能读标", desc: "自动提取评分点与废标项" },
  { icon: ListTree, title: "生成提纲", desc: "对齐评分点的标书目录" },
  { icon: PenLine, title: "标书生成", desc: "逐章生成可编辑内容" },
  { icon: ShieldCheck, title: "标书审查", desc: "废标体检 + 查重 + 终极审核表" },
  { icon: Presentation, title: "述标演示", desc: "一键生成答辩 PPT" },
]

const capabilities = [
  {
    icon: ShieldAlert,
    title: "废标风险提前发现",
    desc: "资质、响应、格式逐项体检，导出前拦住会导致直接废标的低级失误。",
  },
  {
    icon: Target,
    title: "紧扣评分点不漏项",
    desc: "每个章节自动对应招标评分点，覆盖率一目了然，把分尽量拿满。",
  },
  {
    icon: ClipboardCheck,
    title: "投递前终极审核表",
    desc: "递交前逐条核对密封、签章、份数与实质性条款，按清单签收再投。",
  },
  {
    icon: Presentation,
    title: "述标答辩 PPT",
    desc: "依据中标方案一键生成述标大纲与演示文稿，答辩环节不再临时抱佛脚。",
  },
]

const audiences = [
  { icon: User, title: "个人投标用户", desc: "第一次写标书也能快速上手，积分按需充值、用多少买多少。" },
  { icon: Briefcase, title: "标书代写从业者", desc: "批量接单、快速交付，把时间花在打磨方案与述标答辩上。" },
  { icon: Users, title: "中小投标团队", desc: "多项目并行推进，资料库统一沉淀，模板与业绩全程复用。" },
]

const trustPoints = ["注册赠 200 积分体验全流程", "数据全程加密", "积分按需充值或开通会员"]

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* 顶部轻导航 */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
        {/* h-16 与工具页顶栏一致;右侧登录态感知（已登录直达工作台,不再永远显示「免费试用」） */}
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl gradient-brand">
              <Sparkles className="size-4 text-white" />
            </span>
            <span className="text-[15px] font-bold tracking-tight text-foreground">智启元 · 投标助手</span>
          </div>
          <HomeAuthNav />
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 gradient-brand-soft" aria-hidden />
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 sm:py-16 lg:grid-cols-2 lg:py-20">
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-card px-3 py-1 text-xs font-medium text-primary shadow-sm">
              <Sparkles className="size-3.5" />
              AI 驱动的标书全流程工具
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight text-foreground text-balance sm:text-5xl">
              上传招标文件
              <br />
              <span className="text-gradient-brand">AI 帮你写完整份标书</span>
            </h1>
            <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-muted-foreground text-pretty lg:mx-0">
              读标 → 提纲 → 标书生成 → 标书审查（废标体检 / 查重 / 终极审核表）→ 述标演示，一站搞定。无需安装，手机号注册即可使用。
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl gradient-brand px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                免费上传招标文件
                <ArrowRight className="size-4" />
              </Link>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              注册即送 200 积分，可完整体验全流程 · 数据全程加密 · 即开即用
            </p>
          </div>

          <div className="relative">
            <HeroMock />
          </div>
        </div>
      </section>

      {/* 流程 6 步 */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">六步完成一份标书</h2>
          <p className="mt-3 text-sm text-muted-foreground">不用学习复杂系统，跟着流程走就行</p>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {flow.map((step, i) => (
            <div
              key={step.title}
              className="flex flex-col items-center rounded-2xl border border-border bg-card p-5 text-center shadow-sm transition-shadow hover:shadow-md"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <step.icon className="size-5" />
              </span>
              <span className="mt-3 text-xs font-medium text-primary">第 {i + 1} 步</span>
              <h3 className="mt-1 text-sm font-semibold text-foreground">{step.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 核心能力 */}
      <section className="bg-secondary/40 py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">核心能力</h2>
            <p className="mt-3 text-sm text-muted-foreground">把投标里最耗时、最容易出错的环节交给 AI</p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {capabilities.map((c) => (
              <div
                key={c.title}
                className="rounded-2xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <span className="flex size-11 items-center justify-center rounded-xl gradient-brand text-white">
                  <c.icon className="size-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-foreground">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{c.desc}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-6 flex max-w-2xl items-center justify-center gap-2.5 rounded-2xl border border-primary/20 bg-card px-5 py-4 text-center shadow-sm">
            <Library className="size-5 shrink-0 text-primary" />
            <p className="text-sm text-muted-foreground text-pretty">
              <span className="font-semibold text-foreground">我的资料库</span>
              ：企业资质、过往业绩、常用话术一次录入，后续项目全程复用。
            </p>
          </div>
        </div>
      </section>

      {/* 适用人群 */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">谁在用 智启元 · 投标助手</h2>
          <p className="mt-3 text-sm text-muted-foreground">无论投标频率高低，都能找到合适的使用方式</p>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {audiences.map((a) => (
            <div
              key={a.title}
              className="rounded-2xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <a.icon className="size-5" />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-foreground">{a.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{a.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 底部 CTA */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl gradient-brand px-6 py-14 text-center shadow-lg">
          <h2 className="text-2xl font-bold tracking-tight text-white text-balance sm:text-3xl">
            现在就上传招标文件，免费体验完整流程
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/85 text-pretty">
            注册赠 200 积分即可跑通读标到述标的全流程，积分按需充值或开通会员，用多少买多少。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-primary transition-colors hover:bg-white/90"
            >
              免费开始
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <ul className="mx-auto mt-8 flex max-w-xl flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {trustPoints.map((t) => (
              <li key={t} className="flex items-center gap-1.5 text-xs text-white/85">
                <CheckCircle2 className="size-3.5" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-lg gradient-brand">
              <Sparkles className="size-3 text-white" />
            </span>
            <span className="font-medium text-foreground">智启元 · 投标助手</span>
          </div>
          <p>让每一次投标都更高效、更稳健</p>
          <div className="flex items-center gap-3">
            <p>© 2026 智启元 · 投标助手</p>
            <Link href="/terms" className="hover:text-foreground">
              用户协议
            </Link>
            <Link href="/privacy" className="hover:text-foreground">
              隐私政策
            </Link>
            <Link href="/algorithm" className="hover:text-foreground">
              算法公示
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
