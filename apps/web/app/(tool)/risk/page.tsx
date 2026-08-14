"use client"

import { useState } from "react"
import Link from "next/link"
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Copy,
  ListChecks,
  UploadCloud,
  Loader2,
} from "lucide-react"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { ReviewEntry } from "./review-entry"
import { RejectUploadPanel } from "./reject-upload-panel"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepRunCta } from "@/components/tool/step-run-cta"
import { AiNotice } from "@/components/tool/ai-notice"
import { deriveRisk, scanNotice, scanFileLabel, type RealRisk } from "@/lib/risk-derive"
import { stepPrereq, useStep } from "@/lib/use-step"
import { phaseProgress } from "@/lib/project"
import { isUploading } from "@/lib/upload-progress"
import { tenderLocateHref } from "@/lib/tender-locate"
import { BidTextDialog } from "./bid-text-dialog"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { ContrastReviewCta } from "./contrast-run"
import { LegacyDocAdvice } from "@/components/tool/legacy-doc-advice"
import { Checklist } from "./checklist"
import { DedupReview } from "./dedup-review"
import { toneClasses } from "./shared"

type Tab = "reject" | "dedup" | "checklist"

import { CategoryCard } from "../category-card"

export default function ReviewPage() {
  const [tab, setTab] = useState<Tab>("reject")

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
      <FlowNav current="risk" />
      {/* 标题栏 */}
      <StepPageHeader icon={ShieldCheck} title="标书审查" desc="废标风险审查 + 标书查重，交付前帮你拦住风险" />

      {/* Tab 切换 */}
      <div className="mt-5 flex gap-2">
        <button
          onClick={() => setTab("reject")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "reject" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <ShieldAlert className="size-4" />
          废标风险审查
        </button>
        <button
          onClick={() => setTab("dedup")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "dedup" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <Copy className="size-4" />
          标书查重
        </button>
        <button
          onClick={() => setTab("checklist")}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "checklist" ? "gradient-brand text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <ListChecks className="size-4" />
          终极审核表
        </button>
      </div>

      <div className="mt-5">
        {tab === "reject" ? <RejectReview /> : tab === "dedup" ? <DedupReview /> : <Checklist />}
      </div>
    </div>
  )
}


/** 运行中一行 + 可选进度条（审查页用的是自己的横幅样式，不套 StepBanner）。 */
function RunningLine({ label, progress }: { label: string; progress: { done: number; total: number } | null }) {
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
    : null
  return (
    <div>
      <div className="flex items-center gap-2 font-medium text-primary">
        <span className="min-w-0 flex-1">{label}</span>
        {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </div>
      {pct !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
          <div className="h-full rounded-full gradient-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/* ============== 废标风险审查 ============== */
function RejectReview() {
  // review 步产 RiskReport（计费步）：绝不自动触发，一律用户显式点击「开始废标体检」才跑。
  // 默认统一进入独立审查入口（选已生成项目 / 上传线下标书），不默认衔接当前项目已生成的标书；
  // ?view=project = 用户已在入口显式选「当前项目直连审查」（入口内返回/选项目/传标书后跳这里）。
  // 本组件在 RequireAuth 之后才客户端挂载，惰性读 URL 参数无 SSR 水合问题。
  const [viewParam] = useState(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view")),
  )
  const goEntry = () => { window.location.href = "/risk?view=entry" }
  // 在途上传：切菜单会把上传面板卸载，但那段 async 照跑完。**必须排在所有视图分支之前**——
  // 切回 ?view=upload 会把面板重挂成一张空表单，用户以为没传成功就再传一遍，建出重复项目、
  // 后面每步重复扣费；切回裸 /risk 则直接看到旧项目的报告，完全看不出还有一笔在传。
  // 惰性读一次即可：本组件不会在上传完成的那一刻重新挂载，跳转由上传方自己发起。
  const [uploading, setUploading] = useState(() => isUploading("/risk"))
  // 点开「标书原文」时定位到哪一条（null = 弹层关闭）。线下标书没有可编辑正文，
  // 报告卡片以前点哪儿都没反应，这是 #97② 补的那条路。
  const [bidTextAt, setBidTextAt] = useState<{ targetId: string; chapterTitle: string; anchorText: string } | null>(null)
  const { projectId, info, data: real, dataLoading, running, phase, error, errorAction, start } = useStep<RealRisk>("review")
  const { overview: membershipOverview } = useMembership()
  const reviewCost = creditCostValue(membershipOverview, "review", 60)
  const readCost = creditCostValue(membershipOverview, "read", 20)

  // ?view=entry：用户从面板里点了「从我的标书选择」，给「选项目 / 传标书」的中转页。
  // 「返回当前项目的审查」仅在当前项目确可审查时给出——否则不给，避免对未生成正文的在途项目
  // 给一个点了会空转回入口的死链（整页跳转带 ?view=project）。
  if (uploading)
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-6 text-sm">
        <div className="flex items-center gap-2 font-medium text-primary">
          <Loader2 className="size-4 animate-spin" />
          正在上传并创建线下标书…（文件较大时需要几分钟，可以先去别处，传完回本页即可看到）
        </div>
        {/* 不放「点这里重新上传」：原来那笔上传在文档没被拆掉时仍然活着（切菜单只是卸载组件），
            劝用户重传就是建出两个线下标书项目、之后每一步双倍计费。整页跳转/刷新会走 pagehide
            把标记清掉，所以真死掉的上传不会卡在这个界面上。 */}
        <a href="/projects" className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
          等太久了？去「我的标书」看看是否已经创建 →
        </a>
      </div>
    )
  if (viewParam === "entry")
    return (
      <ReviewEntry
        onBack={projectId && info && !stepPrereq(info, "review") ? () => { window.location.href = "/risk?view=project" } : undefined}
      />
    )
  // ?view=upload：用户在选择列表里点了「没有合适的项目？改为上传线下标书」。**必须排在报告分支
  // 之前**——当前项目已有审查报告时，下面会直接渲染报告，那条上传路径就再也走不到（用户实测：
  // 已体检的项目一点这个按钮就弹回报告页，线下标书永远传不上去）。
  // 传完不能 reload：地址上还挂着 view=upload，会原地弹回上传面板，看着像没传成功。
  if (viewParam === "upload")
    return (
      <RejectUploadPanel
        onPickExisting={goEntry}
        onCreated={() => { window.location.href = "/risk?view=project" }}
      />
    )
  // 没有当前项目：只能传文件（选项目那张卡在中转页里，由上面的次要入口进）
  if (!projectId) return <RejectUploadPanel onPickExisting={goEntry} onCreated={() => window.location.reload()} />

  // 项目状态/审查报告加载中：数据未就绪绝不裸露「开始废标体检」计费按钮
  if (!info || dataLoading) return <StepPlaceholder text={dataLoading ? "正在加载审查报告…" : "正在加载项目…"} delayMs={250} />

  if (running || error) {
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-6 text-sm">
        {running ? (
          // 审查这条路才是真会跑 OCR 的（parse_bid_docs 逐页识别扫描件，代码里给到 20 分钟上限），
          // 阶段事件带 done/total 时必须画出来——否则最漫长、最不透明的那一段依旧是一行不动的字。
          <RunningLine label={phase ? `AI ${phase.label}…（约 1–2 分钟）` : "AI 正在逐条比对招标要求与标书内容，生成废标体检报告…（约 1–2 分钟）"}
                       progress={phaseProgress(phase)} />
        ) : (
          <span className="flex items-center justify-between text-destructive">
            {error}
            {errorAction ? (
              <Link href={errorAction.href} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
                {errorAction.label}
              </Link>
            ) : (
              <button onClick={() => void start()} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">重试</button>
            )}
          </span>
        )}
      </div>
    )
  }

  // 该步未跑：
  // - 前序（标书生成）未完成 → 不再引导「前往标书生成」，直接给独立审查入口：标书审查是独立能力，
  //   上传线下标书 / 选已有标书即可审查，不强制先在库内生成。
  // - 前序已就绪 → 给显式体检按钮（明示消耗）+ 顶部独立审查入口条。
  // 该步未跑（用户要求：入口就是双上传面板）：
  // - 前序（标书生成）未完成 → 只有上传面板：审查是独立能力，不强制先在库内生成正文。
  // - 前序已就绪 → 面板之上再给一张「直接审查当前项目」的卡：本项目的招标文件与正文都在库里，
  //   不该逼用户把已有的东西重传一遍（六步流水线的正常下一步，丢了就断链）。
  // 项目文件名（.doc 另存提示用）：key 末段即上传时的原始文件名
  const projectDocNames = [
    ...(info.project.bidFileKeys ?? []),
    ...(info.project.tenderFileKeys ?? (info.project.tenderFileKey ? [info.project.tenderFileKey] : [])),
  ].map((k) => k.split("/").pop() ?? k)

  if (!real) {
    const gap = stepPrereq(info, "review")
    // review-kind 项目（对照审查）读标一旦跑完，currentStep 就推进到 review，gap 随即变 null——
    // 但审查步本身还没跑。CTA 此前挂在 `gap &&` 后面，这一刻会连着「还差一步」提示条一起消失，
    // 只剩下面的重传面板，用户以为要重新上传（主#15：只留一条 4 跳的「从我的标书选择」迂回路）。
    // 显不显示 CTA 只该看"是不是对照审查项目"，不该再掺 gap。
    const contrastReady = info.project.kind === "review" && !!info.project.tenderFileKey
    const readDone = info.steps.some((s) => s.step === "read" && s.status === "done")
    return (
      <div className="flex flex-col gap-3">
        {/* 分类卡必须在**第一次付费审查之前**就能改：审查节点是先分类再审查、当轮即用，
            放到报告出来之后才给改，用户就得再花一次钱重跑才生效——正是这个设计要避免的。
            只对没有招标文件的线下自查项目渲染（有招标文件的在读标页改）。 */}
        {!info.project.tenderFileKey && (
          <CategoryCard
            projectId={projectId}
            confirmed={info.project.bidCategory}
            detected={info.detectedCategory}
          effective={info.effectiveCategory}
            applyHint="已保存，本次审查即按此进行"
          />
        )}
        {/* 刚传完文件建好项目、正在读标时回到本页，原来只剩一张空白上传面板——
            用户会以为"刚才没传成功"再传一遍，等于重复付一次读标钱。明确告诉他项目在哪。 */}
        {/* 上传了招标文件与投标文件的独立审查项目：**不再把用户支去招标解读**。
            读标是对照审查的必需输入（要求清单从那儿来），但它是内部步骤，这里一并跑掉。
            其它形态（库内项目缺正文等）保留原来的"前往上一步"引导。 */}
        <LegacyDocAdvice names={projectDocNames} className="text-xs" />
        {contrastReady ? (
          <ContrastReviewCta
            projectId={projectId}
            projectName={info.project.name ?? "我的标书"}
            readCost={readCost}
            reviewCost={reviewCost}
            hasPackage={!!info.project.selectedPackage}
            readDone={readDone}
            onDone={() => window.location.reload()}
          />
        ) : gap ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/30 gradient-brand-soft px-4 py-3 text-sm">
            <span className="text-foreground">
              当前项目「{info?.project.name ?? "我的标书"}」还差一步：{gap.label}完成后即可体检，无需重新上传
            </span>
            <a href={gap.href} className="shrink-0 rounded-lg gradient-brand px-3 py-1.5 text-xs font-semibold text-white">
              前往{gap.label}
            </a>
          </div>
        ) : null}
        {/* 「审查当前项目」只在**显式选了项目之后**出现（?view=project，从「从我的标书选择」进来）。
            默认落地页不摆它：用户口径「不要有审查当前项目，统一走从我的标书选择」——
            默认页只有上传面板 + 一个去列表的入口，路径唯一，不会一进来就对着一个不知是哪份标书的
            60 积分按钮。 */}
        {!gap && !contrastReady && viewParam === "project" && (
          <div className="rounded-2xl border border-border bg-card">
            <StepRunCta
              title={`审查「${info?.project.name ?? "当前项目"}」`}
              desc="直接取本项目的招标文件与已生成正文逐条比对，生成健康分、风险项与整改建议（无需重新上传）"
              costText={`消耗 ${reviewCost} 积分`}
              actionLabel="开始废标体检"
              onRun={() => void start()}
            />
          </div>
        )}
        {viewParam === "project" ? (
          // 选定项目后不再摆上传面板（此处只该做一件事）；但要留一条回列表的路，否则换标书只能按浏览器后退
          <button onClick={goEntry} className="self-center text-xs font-medium text-primary hover:underline">
            ← 换一份标书审查
          </button>
        ) : (
          <RejectUploadPanel onPickExisting={goEntry} onCreated={() => window.location.reload()} />
        )}
      </div>
    )
  }

  const { score, overview, riskItems, passed } = deriveRisk(real)
  const scan = scanNotice(real)
  // 能不能跳回招标原文：得**这个项目真有招标文件、且读标真跑完**。线下自查项目（只传了标书、
  // 没传招标文件）跳过去是一片空白，给个必然落空的链接比不给更糟。
  const tenderLocatable = !!info.project.tenderFileKey
    && info.steps.some((st) => st.step === "read" && st.status === "done")
  // 线下上传的标书才有「标书原文」可看：系统生成的标书正文在正文页，那边点「定位到本章修改」。
  const bidTextAvailable = info.project.kind === "review"
  return (
    <div className="flex flex-col gap-6">
        <EntryBar onOpen={goEntry} />
        <AiNotice />
        <LegacyDocAdvice names={projectDocNames} className="text-xs" />
        {/* 扫描页/内嵌图横条：这些内容一个字都没进过比对（pdf 识别不出来，或没部署识别服务；
            docx 内嵌图片本身没有文字，1a09214 加），报告里与它们有关的结论——尤其是「缺少某材料」
            ——必须由人再看一眼。不说的话，一份大半是扫描件/内嵌图的标书看起来和一份完整审查过的标书一模一样。 */}
        {scan && (
          <div className="flex items-start gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              本标书
              {scan.pages > 0 && (
                <>
                  有 <span className="font-semibold">{scan.pages}</span> 页为扫描件且未能识别出文字
                </>
              )}
              {scan.pages > 0 && scan.images > 0 && "，"}
              {scan.images > 0 && (
                <>
                  含 <span className="font-semibold">{scan.images}</span> 张 docx 内嵌图片内容不可见
                </>
              )}
              （{scan.files.map(scanFileLabel).join("、")}），这些内容未参与本次比对，相关结论请人工复核。
            </p>
          </div>
        )}
        {/* 标书分类（spec334）：**只在没有招标文件的线下自查项目上渲染**——那类项目不跑读标、
            没有读标页，分类是在审查节点开头现判的，用户只能在这里改判。有招标文件的项目在读标页改。 */}
        {!info.project.tenderFileKey && (
          <CategoryCard
            projectId={projectId}
            confirmed={info.project.bidCategory}
            detected={info.detectedCategory}
          effective={info.effectiveCategory}
            applyHint="已保存，重跑审查后生效"
          />
        )}
        {/* 健康分 */}
        <div className="flex flex-col items-center gap-5 rounded-3xl border border-border bg-card p-8 sm:flex-row sm:gap-8">
          <div className="flex size-28 shrink-0 flex-col items-center justify-center rounded-full gradient-brand-soft">
            <span className="text-3xl font-bold text-gradient-brand">{score}</span>
            <span className="text-xs text-muted-foreground">健康分</span>
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              <ShieldAlert className="size-5 text-warning" />
              <p className="text-base font-semibold text-foreground">
                {overview[0].value > 0 ? `发现 ${overview[0].value} 项高风险，建议处理后再交付` : "未发现高风险项"}
              </p>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {overview.map((o) => (
                <div key={o.label} className="rounded-xl border border-border bg-background py-3 text-center">
                  <p className={`text-xl font-bold ${toneClasses[o.tone].icon}`}>{o.value}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{o.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {bidTextAt && (
          <BidTextDialog
            projectId={projectId}
            targetId={bidTextAt.targetId}
            chapterTitle={bidTextAt.chapterTitle}
            anchorText={bidTextAt.anchorText}
            onClose={() => setBidTextAt(null)}
          />
        )}

        {/* 风险项 */}
        <section className="flex flex-col gap-3">
          {riskItems.map((item, i) => (
            // key 带上下标：同名风险项会撞 key（用户实测出现过三条同名卡片），React 会认成同一个
            <div key={`${item.title}-${i}`} className={`rounded-2xl border bg-card p-5 ${toneClasses[item.tone].border}`}>
              <div className="flex items-start gap-3">
                <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${toneClasses[item.tone].icon}`} />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${toneClasses[item.tone].badge}`}>
                      {item.level}
                    </span>
                    <TenderRefLink chapter={item.chapter} enabled={tenderLocatable} />
                    {bidTextAvailable && (
                      <button
                        onClick={() => setBidTextAt({ targetId: item.targetId, chapterTitle: item.chapterTitle, anchorText: item.anchorText })}
                        className="text-xs text-primary hover:underline"
                      >
                        定位到标书原文 →
                      </button>
                    )}
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-foreground">{item.title}</h3>
                  {/* 建议为空就整块不画：画一个只有「整改建议：」的空框，比不画更像出了故障
                      （用户实测截图：三张卡片的建议全是空白）。新结果已在 schema 层要求必填。 */}
                  {item.advice?.trim() && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl bg-secondary/60 p-3">
                      <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">整改建议：</span>
                        {item.advice}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* 已通过 */}
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-success" />
            <h2 className="text-base font-semibold text-foreground">已通过检查项</h2>
          </div>
          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {passed.map((p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-foreground">
                <CheckCircle2 className="size-4 shrink-0 text-success" />
                {p}
              </li>
            ))}
          </ul>
        </section>
      </div>
  )
}

/* 独立审查入口条：挂着项目时也能一键切到「选标书/上传线下标书」（防止只有查重 tab 可见上传的误解） */
function EntryBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex justify-end">
      <button
        onClick={onOpen}
        className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 gradient-brand-soft px-4 py-2 text-sm font-semibold text-primary transition-opacity hover:opacity-90"
      >
        <UploadCloud className="size-4" />
        审查其它标书 / 上传线下标书 →
      </button>
    </div>
  )
}

/** 招标出处：能定位就渲染成链接，跳读标页把原文滚出来并高亮。
 *  没有招标文件（线下自查项目）或出处太短时保持灰字——给一个点了必然落空的链接更糟。 */
function TenderRefLink({ chapter, enabled }: { chapter: string; enabled: boolean }) {
  const href = enabled ? tenderLocateHref(chapter) : null
  if (!href) return <span className="text-xs text-muted-foreground">{chapter}</span>
  return (
    <a href={href} title="在招标原文中查看这一条要求" className="text-xs text-primary hover:underline">
      {chapter} →
    </a>
  )
}
