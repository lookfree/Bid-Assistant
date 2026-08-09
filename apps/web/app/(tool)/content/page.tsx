"use client"

import Link from "next/link"
import { stripDocumentShell, type BidChapter, type OutlineItem } from "@/lib/bid-types"
import { countChars, fmtChars } from "@/lib/doc-stats"
import { estimatePagesFromHtml } from "@/lib/page-estimate"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  FileText,
  Briefcase,
  Layers,
  Sparkles,
  RefreshCw,
  Download,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Coins,
} from "lucide-react"
import { usePaywall } from "@/components/paywall"
import { FlowNav } from "@/components/tool/flow-nav"
import { StepPageHeader } from "@/components/tool/step-page-header"
import { StepBanner } from "@/components/tool/step-banner"
import { NoProjectGuide } from "@/components/tool/no-project-guide"
import { StepPlaceholder } from "@/components/tool/step-placeholder"
import { StepPrereqGuide } from "@/components/tool/step-prereq-guide"
import { LibraryPicker } from "@/components/tool/library-picker"
import { useEscapeClose } from "@/hooks/use-escape-close"
import { useMembership } from "@/lib/use-membership"
import { creditCostValue } from "@/lib/membership-view"
import { tiersCostText } from "@/lib/content-tiers"
import { useLibrary } from "@/lib/use-library"
import { type LibraryItem } from "@/lib/library"
import { deriveHealthReport } from "@/lib/risk-derive"
import { ITEM_ANCHOR_MIN, outlineItemAnchor, scrollToAnchor } from "@/lib/anchor"
import { stepNotApplicable, stepPrereq, useOtherStepResult, useStep } from "@/lib/use-step"
import { normalizeChapterHtml } from "@/lib/chapter-normalize"
import { camelArtifactKey, useExport } from "./use-export"
import { artifactKeys, scopeAvailability, volumeStale, type ExportScope } from "@/lib/export-scope"
import type { ExportPreview } from "@/lib/project"
import { AiNotice } from "@/components/tool/ai-notice"
import { ApiError } from "@/lib/api-client"
import { rewriteChapter, triggerDownload } from "@/lib/project"
import { exportRiskReport } from "@/lib/risk-api"
import { ChatPanel } from "./chat-panel"
import { EditorToolbar } from "./editor-toolbar"
import { ChapterNav, type Chapter } from "./chapter-nav"
import { CheckConfirm, CheckSummary, ExportConfirm } from "./check-dialogs"
import { ExportMenu, type BidType } from "./export-menu"
import { ReportDialog } from "./report-dialog"
import { useHealthCheck } from "./use-health-check"
import { useChapterEdits } from "./use-chapter-edits"
import { libraryItemHtml, loadAttachmentImages } from "./use-editor-insert"
import { RichEditor } from "./rich-editor"
import type { Editor as TiptapEditor } from "@tiptap/react"
import { GenerationConfigDialog } from "./generation-config"
import { genConfigFingerprint, loadGenConfig, sanitizeFormat, storedTargetFor } from "@/lib/generation-config"

// agent content 步结果（camelCase）：{chapterId: bodyHtml}；章结构取 outline 步结果
type RealChapters = Record<string, string>
// 与提纲页同一份形状（items 是章内小标题，左栏据此展开子目录）
type RealOutline = { chapters: BidChapter[] }

type Group = "tech" | "business"

const bidTabs: { id: BidType; name: string; icon: React.ElementType }[] = [
  { id: "tech", name: "技术标", icon: FileText },
  { id: "business", name: "商务标", icon: Briefcase },
  { id: "full", name: "标书全文", icon: Layers },
]

/** 补写失败的可读文案：服务端给了 detail 就用它——「请稍后重试」对着一件做不到的事没有意义。 */
function rewriteErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 402) return "积分余额不足"
    if (e.code === "feature_locked") return "当前会员档位未包含该权益"
    if (e.code === "rewrite_truncated") return "本章篇幅过大，模型未能完整输出"
    if (e.detail) return e.detail
  }
  return "请稍后重试"
}

const SCOPE_LABEL: Record<ExportScope, string> = { full: "", tech: "技术标册", business: "商务标册" }

/** 下载区（2026-08-09 export-scope）：已产出的分册再下载，不重渲、不再计费——遍历三种 scope，
 *  exportedResult（export 步结果快照，已 toCamel）里存在的产物键才出按钮，全量/技术/商务并存。
 *  终审 C1：exportedResult 里某册的 docx/pdf 键一旦产出就不会消失（agent 侧 artifacts 通道跨 run
 *  合并，见 use-export.ts 里 pdfUnavailableFor 同一处注释）——只按"键是否存在"出按钮，会让改稿后
 *  没重新导出的册也显示"可下载"，一点就下到改稿前的旧文件。preview.volumes[scope] 是该册最近一次
 *  真渲染的时刻，与 preview.content_changed_at 比较才知道这个键背后的文件是不是最新的。 */
function scopedDownloads(
  exported: Record<string, string | number | undefined> | null,
  preview: ExportPreview | null,
): { key: string; kind: string; text: string; stale: boolean }[] {
  if (!exported) return []
  const out: { key: string; kind: string; text: string; stale: boolean }[] = []
  const contentChangedAt = preview?.content_changed_at ?? null
  for (const s of ["full", "tech", "business"] as ExportScope[]) {
    const keys = artifactKeys(s)
    const label = SCOPE_LABEL[s] ? `（${SCOPE_LABEL[s]}）` : ""
    const exportedAt = preview?.volumes[s === "business" ? "biz" : s] ?? null
    const stale = volumeStale(exportedAt, contentChangedAt, true)
    if (exported[camelArtifactKey(s, "docx")]) out.push({ key: `${s}-docx`, kind: keys.docx, text: `下载 Word${label}`, stale })
    if (exported[camelArtifactKey(s, "pdf")]) out.push({ key: `${s}-pdf`, kind: keys.pdf, text: `下载 PDF${label}`, stale })
  }
  return out
}

export default function ContentPage() {
  const [bidType, setBidType] = useState<BidType>("tech")
  // 章节树：从空开始，由 outline/content 结果构建
  const [data, setData] = useState<Record<Group, Chapter[]>>({ tech: [], business: [] })
  // 组顺序跟随提纲 chapters 数组顺序（提纲页可设商务标在前）：全文视图/导出目录一致
  const [bizFirst, setBizFirst] = useState(false)

  // outline 树 + content 各章 HTML → 构建章节树；计费步绝不自动触发，生成一律走显式按钮
  const { projectId, info, data: realBodies, dataLoading, running, progress, phase, error, errorAction, start } = useStep<RealChapters>("content")
  // 正文运行态文案：心跳（每 5s 一条，「第 N 章成稿中·本章已 X 分」）让横幅持续动——单章一次长调用
  // 要 2~8 分钟，只靠章节事件横幅会定格几分钟，用户会读成"卡住了"（实测反馈）。
  // 心跳与逐章进度都在时拼着显示；都没有才给静态耗时预期。
  const contentRunningText = phase
    ? `AI 正在逐章撰写：${progress ? `已完成 ${progress.done}/${progress.total} 章，` : ""}${phase.label}…`
    : progress
      ? `AI 正在逐章撰写：已完成 ${progress.done}/${progress.total} 章${progress.title ? `（刚写完「${progress.title}」）` : ""}，请稍候…`
      : "AI 写手团队正在逐章撰写正文…章节多、招标文件大时约需 5–15 分钟，可离开本页，回来会自动接着显示进度。"
  // outline 结果按需拉取（slim 首屏不携带跨步结果）：到位后先建树（正文缺失章显示"待生成"占位），
  // content 结果到位后填充各章 HTML
  const { data: outlineResult, loading: outlineLoading, error: outlineError } = useOtherStepResult<RealOutline>(projectId, info, "outline")
  useEffect(() => {
    const ol = outlineResult
    if (!ol) return
    const build = (g: Group) =>
      ol.chapters
        .filter((c) => c.group === g)
        .map((c) => ({ id: c.id, no: c.no, title: c.title, sourced: c.sourced,
                     html: realBodies?.[c.id] ?? "",
                     // 章内条目带下去：左栏据此展开子目录，点条目跳到章内该小标题处
                     items: (c.items ?? []).map((i: OutlineItem) => ({ id: i.id, label: i.label })) }))
    setData({ tech: build("tech"), business: build("business") })
    setBizFirst(ol.chapters[0]?.group === "business")
    setActiveId((prev) => (ol.chapters.some((c) => c.id === prev) ? prev : (ol.chapters[0]?.id ?? "")))
  }, [realBodies, outlineResult])
  const [activeId, setActiveId] = useState<string>("t1")
  const [chatOpen, setChatOpen] = useState(true)
  const [editor, setEditor] = useState<TiptapEditor | null>(null)
  const editorScrollRef = useRef<HTMLDivElement>(null)
  // 外部替换正文（AI 改写/快照回退）→ epoch+1 → RichEditor 换 key 重挂:内容与撤销栈干净重置
  const [editorEpoch, setEditorEpoch] = useState(0)
  const { openPaywall } = usePaywall()

  /* 真实积分余额与会员身份（GET /api/membership；仅 active 订阅算会员，决定整改建议是否完整可见） */
  // isMember 不再解构：整改建议的可见性改由服务端裁剪决定（result.adviceLocked，评审修正）
  const { overview, balance, loading: membershipLoading, error: membershipError, reload: reloadMembership } = useMembership()
  /* 计费口径：优先后端实时配置（运营可改），缺省回落默认值 */
  const reviewCost = creditCostValue(overview, "review", 60)
  /* 标书生成计费阶梯（按产出总字数分档，运营后台可增删）；文案与实际扣减同源，前端不写死。
     三态严格区分：加载中 / 拉取失败 ≠ 运营未配置——把一次网络抖动说成「请联系运营」会把用户和
     客服一起引到错误方向。只有 overview 确实到手、阶梯仍为空，才判定为未配置。 */
  const tiersLoaded = !membershipLoading && !!overview
  const contentCostText = membershipLoading
    ? "计费口径加载中…"
    : !overview
      ? "计费口径加载失败，请刷新重试"
      : tiersCostText(overview.contentTiers ?? [])
  /* 阶梯已确认配置：为空 = 未配置/配置非法，后端会 400 拒跑。加载中/失败一律按未确认处理，
     付费生成入口保持锁死（铁律：非确认态绝不亮计费按钮），但提示文案分开给。 */
  const tiersConfigured = tiersLoaded && (overview!.contentTiers ?? []).length > 0
  const contentCtaBlockedReason = tiersConfigured
    ? undefined
    : !tiersLoaded
      ? "计费口径尚未加载完成，请稍候或刷新重试"
      : "计费阶梯未配置，请联系运营在后台设置后重试"
  const exportCost = creditCostValue(overview, "export", 20) // 后台实时口径,勿用静态副本(与实际扣减一致)
  /* 余额是否足够支付本次导出消耗（仅影响导出付费墙，不影响整改建议解锁） */
  const canAfford = balance >= exportCost
  /* 资料库数据提升到页面级：LibraryPicker 弹层复用，避免每次打开全量重拉 */
  const { items: libItems, loading: libLoading, error: libError } = useLibrary()

  /* 真实项目且正文已生成：编辑持久化 / 单章改写通道可用 */
  const isReal = !!(projectId && realBodies)

  /* 废标体检：真实项目跑真实 review 步，demo 回落示例（content 未完成时不可体检） */
  const { checkState, findings, canCheck, runCheck, checkError, checkErrorStatus } = useHealthCheck(isReal)
  const healthCheck = useMemo(() => (findings ? deriveHealthReport(findings) : null), [findings])
  const [checkOpen, setCheckOpen] = useState(false)
  /* 体检计费确认弹层：体检（review 步）是计费步，任何路径都先显式确认；值为触发来源 */
  const [checkConfirm, setCheckConfirm] = useState<null | "check" | "export">(null)
  /* 就地完整体检报告弹层 */
  const [reportOpen, setReportOpen] = useState(false)
  const [reportExportStatus, setReportExportStatus] = useState<string>("")
  /* 从资料库插入弹层 */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [genConfigOpen, setGenConfigOpen] = useState(false)
  /* 导出前高风险二次确认 */
  const [exportConfirm, setExportConfirm] = useState(false)
  /* 用户已软放行（确认仍要导出后不再重复拦截） */
  const [softPassed, setSoftPassed] = useState(false)

  /* 导出全流程（入口/步序闸/断流收敛/断点续看）拆到 use-export.ts；确认弹层仍在本页,回调发信号 */
  const {
    exportOpen, setExportOpen, exportFormat, setExportFormat, exportStatus, flashExportStatus,
    exportScope, setExportScope, preview, exportedResult, redownload,
    exportGate, exportGateHint, hasExported, pdfUnavailable, exporting, freeRerender, markContentChanged,
    onExportEntry, attemptExport, doExport,
  } = useExport({
    projectId, info, membershipLoading, canAfford,
    openPaywall: () => openPaywall("export"),
    canCheck, isReal, findings, checkState, runCheck, softPassed,
    requestCheckConfirm: () => setCheckConfirm("export"),
    onHighRisk: () => setExportConfirm(true),
  })
  // 下载区（分册再下载）：exportedResult 判"该册是否已产出"（不额外发请求），preview 判"是否过期"
  const scopedDownloadItems = scopedDownloads(exportedResult, preview)
  const scopeAvail = scopeAvailability(outlineResult?.chapters ?? [])

  /** 起跑正文生成：显式给参数用之;缺省（含失败重试路径）回读用户存过的目标字数——
   *  否则重试的付费 run 会静默丢掉篇幅配置（审查修正 2026-07-23）。 */
  function startContent(body?: { targetChars?: number }) {
    const target = body?.targetChars ?? storedTargetFor(projectId)
    return start(target ? { targetChars: target } : undefined)
  }

  // 当前 tab 对应的章节列表（全文按提纲组顺序合并，商务标在前时商务组先行）
  const fullList = (): Chapter[] => (bizFirst ? [...data.business, ...data.tech] : [...data.tech, ...data.business])
  const list: Chapter[] = bidType === "full" ? fullList() : data[bidType]
  // 全部真实章节 id（不分组）：体检报告据此判断某条问题跳不跳得过去
  const allChapterIds = useMemo(
    () => new Set([...data.tech, ...data.business].map((c) => c.id)),
    [data.tech, data.business],
  )
  const active = list.find((c) => c.id === activeId) ?? list[0]
  const generatedCount = list.filter((c) => c.html.trim()).length
  // 本章字数/页数只在 html 变化时重算（正则扫大章节不便宜，页面因保存态/余额刷新频繁重渲染）；
  // 页数按排版感知结构估算（表格/标题按行高计费），格式取用户存的导出偏好
  const activeChars = useMemo(() => countChars(active?.html ?? ""), [active?.html])
  const fmtRaw = genConfigFingerprint() // 格式改过 → 页数估算跟着变（评审 F5）
  const activePages = useMemo(
    () => estimatePagesFromHtml([active?.html ?? ""], sanitizeFormat(loadGenConfig().format ?? {}), { fixedSections: false }),
    [active?.html, fmtRaw],
  )

  // 目录分组（全文模式下展示技术标 / 商务标分组标题，顺序跟随提纲组顺序）
  const groups: { label: string; items: Chapter[] }[] =
    bidType === "full"
      ? (bizFirst
          ? [
              { label: "商务标", items: data.business },
              { label: "技术标", items: data.tech },
            ]
          : [
              { label: "技术标", items: data.tech },
              { label: "商务标", items: data.business },
            ])
      : [{ label: "", items: data[bidType] }]

  function switchBid(id: BidType) {
    saveEditor()
    setBidType(id)
    const newList = id === "full" ? fullList() : data[id]
    setActiveId(newList[0]?.id ?? "")
  }

  /* ---- 补写「待生成」的章 ----
     正文生成被打断是常态（实测 20 章的标书停在第 14 章）。此前页面只在"一章都没有"时给
     生成入口，跑出部分结果后入口就消失，用户只剩右侧小助手一条路——而那条路当时还打不通。
     补写走的是单章通道（不消耗积分），只补空的那几章，绝不重写已写好的：那是用户付过钱的成果。 */
  const DRAFT_INSTRUCTION = "本章尚无正文，请按提纲与招标要求撰写本章正文初稿"
  const missingChapters = useMemo(
    () => [...data.tech, ...data.business].filter((c) => !c.html.trim()),
    [data],
  )
  const [filling, setFilling] = useState<{ done: number; total: number } | null>(null)
  const [fillError, setFillError] = useState("")

  async function draftChapters(list: Chapter[]) {
    if (!projectId || !list.length || filling) return
    setFillError("")
    setFilling({ done: 0, total: list.length })
    let failed = ""
    for (const [i, ch] of list.entries()) {
      try {
        const r = await rewriteChapter(projectId, ch.id, DRAFT_INSTRUCTION)
        applyRewrite(ch.id, r.html)     // 逐章落地：中途失败也保住已补好的几章
      } catch (e) {
        // 失败就停：同一个原因往下跑只会连错 N 次，每次都在烧模型调用
        failed = `「${ch.no} ${ch.title}」补写失败：${rewriteErrorText(e)}`
        break
      }
      setFilling({ done: i + 1, total: list.length })
    }
    setFilling(null)
    setFillError(failed)
  }

  function selectChapter(id: string, anchor?: string) {
    saveEditor()
    setActiveId(id)
    // 点的是章内条目：跳到该小标题处（复用体检报告那套章内定位——换章后 TipTap 要跨两次
    // 渲染才接上 DOM，滚动统一交给 pendingAnchor 的 effect 重试，不在这里直接滚）。
    // 锚点去掉序号与尾部括注：提纲与正文的序号经常对不上（实测命中率 84%→96%）。
    const itemAnchor = anchor ? outlineItemAnchor(anchor) : ""
    setPendingAnchor(itemAnchor ? { id, anchor: itemAnchor, minLen: ITEM_ANCHOR_MIN } : null)
    if (itemAnchor) editorScrollRef.current?.scrollTo({ top: 0 })
  }

  /* 章节编辑/保存/撤销/插入（拆到 use-chapter-edits.ts，800 行规则） */
  const {
    contentSaveState, contentSaveError,
    saveEditor, undoChapter, applyRewrite, insertAtCaret,
    imageInputRef, openImagePicker, onImageChosen,
  } = useChapterEdits({
    isReal, projectId, data, setData, editor, active,
    bumpEpoch: () => setEditorEpoch((e) => e + 1),
    scrollRef: editorScrollRef,
    // 正文一变，导出侧立刻改回「要收费」——否则本次会话内改完再导出会显示「不消耗积分」却被扣
    onContentChanged: markContentChanged,
  })

  function openLibrary() {
    setLibraryOpen(true)
  }
  const [libraryBusy, setLibraryBusy] = useState(false)
  async function insertFromLibrary(item: LibraryItem) {
    // 弹层**保持打开并转圈**，等取图+识别完成再关。
    // 不能提前关：公网带宽实测 21-75KB/s，取一张证照要几秒，这几秒里用户可以切到别的章——
    // 而 insertAtCaret 闭包捕获的是发起时那一章，内容会插进错的章节，空章分支还会用旧快照
    // 覆盖掉这期间对其它章的编辑。开着弹层既挡住了切章，也顺带解决了"点了没反应"。
    setLibraryBusy(true)
    try {
      // 图片附件取回来内嵌，而不是只写一行「附件：图片1.png」——那会让用户以为证照已放进标书，
      // 实际正文里只有个文件名，审查自然报缺件（2026-08-06 用户反馈）
      const { images, alts } = await loadAttachmentImages(item)
      insertAtCaret(libraryItemHtml(item, images, alts))
    } finally {
      setLibraryBusy(false)
      setLibraryOpen(false)
    }
  }

  /* 点击「一键废标体检」按钮：真实项目首次体检先显式确认计费；已有结果开合摘要弹层 */
  async function onCheckClick() {
    if (checkState === "checking" || !canCheck) return
    if (checkState === "done") {
      setCheckOpen((v) => !v)
      return
    }
    // 真实项目且 review 步从未跑过：计费步，弹确认（显示"本次体检消耗 N 积分"）
    if (isReal && !findings) {
      setCheckConfirm("check")
      return
    }
    if (await runCheck()) setCheckOpen(true)
  }

  /* 体检计费确认后真跑 review 步；从「确认导出」进入的，体检完成后继续导出流程 */
  async function confirmCheck() {
    const from = checkConfirm
    setCheckConfirm(null)
    const f = await runCheck()
    if (!f) return
    if (from === "export") {
      if (f.high > 0 && !softPassed) setExportConfirm(true)
      else doExport(exportFormat)
    } else {
      setCheckOpen(true)
    }
  }

  /* 打开就地完整体检报告（关闭其它浮层） */
  function openReport() {
    setCheckOpen(false)
    setExportConfirm(false)
    setReportOpen(true)
  }

  /* 从报告中「定位到本章修改」：切换到对应 tab 与章节并滚动到顶部 */
  function gotoChapter(tab: BidType, id: string, anchor = "") {
    // 章节不存在就不动。此前照跳，而 active 是 `list.find(...) ?? list[0]`——等于静默跳到第一章，
    // 用户以为问题出在那一章（2026-08-07 反馈：点哪条都定位到同一处）。按钮侧已挡，这里兜底。
    if (!allChapterIds.has(id)) return
    setBidType(tab)
    setActiveId(id)
    setReportOpen(false)
    editorScrollRef.current?.scrollTo({ top: 0 })
    // 章内定位：只到章还不够——实测一份报告 63 条里 31 条都指向同一章（偏离表），
    // 逐条点过去全落在章节顶部，看起来就是"点哪条都跳同一个地方"。
    // 真正的滚动交给下面的 effect：换章会让 RichEditor 换 key 重新挂载，而 TipTap
    // （immediatelyRender:false）要跨两次渲染才把 ProseMirror 的 DOM 接上，
    // 在点击回调里排一帧 rAF 常常早于 DOM 出现，然后静默什么也不做。
    setPendingAnchor(anchor.trim() ? { id, anchor } : null)
  }

  /** 待定位的锚点（换章后由 effect 重试执行）。 */
  const [pendingAnchor, setPendingAnchor] = useState<{ id: string; anchor: string; minLen?: number } | null>(null)
  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.id !== active?.id) return
    let stop = false
    let left = 30 // 约 0.5 秒内反复尝试；大章节首次渲染慢，一帧不够
    const tick = () => {
      if (stop) return
      if (scrollToAnchor(editorScrollRef.current, pendingAnchor.anchor, pendingAnchor.minLen) || --left <= 0) {
        setPendingAnchor(null) // 定位到了，或者放弃（维持章节顶部，与老报告一致）
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stop = true
    }
  }, [pendingAnchor, active?.id])

  /* 在体检报告弹层内直接导出标书文件：已查看风险，软放行后导出 */
  function exportBidFromReport(format: "word" | "pdf") {
    setSoftPassed(true)
    setReportOpen(false)
    doExport(format)
  }

  /* 导出体检报告（Word / PDF）：agent 无状态渲染 → 预签名直下（免计费，体检已收过费）。
     此前是原型残留的假实现（setTimeout 报「已导出」但从不产生文件——用户找不到下载物，生产反馈）。 */
  const reportExportingRef = useRef(false)
  async function exportReport(format: "word" | "pdf") {
    if (reportExportingRef.current || !healthCheck) return
    reportExportingRef.current = true
    const fmt = format === "word" ? "docx" : "pdf"
    setReportExportStatus(`正在导出体检报告（${format === "word" ? "Word" : "PDF"}）…`)
    try {
      const res = await exportRiskReport({
        projectName: info?.project.name ?? undefined,
        score: healthCheck.score,
        high: healthCheck.high,
        mid: healthCheck.mid,
        passed: healthCheck.passed,
        items: healthCheck.items.map((i) => ({ level: i.level, title: i.title, chapter: i.chapter, advice: i.advice })),
        passedItems: healthCheck.passedItems,
        format: fmt,
      })
      triggerDownload(res.url)
      setReportExportStatus(
        fmt === "pdf" && res.format === "docx"
          ? `PDF 转换失败，已导出 Word 版《${res.filename}》（见浏览器「下载」列表）`
          : `已开始下载《${res.filename}》，可在浏览器「下载」列表查看`,
      )
    } catch {
      setReportExportStatus("导出体检报告失败，请重试")
    } finally {
      reportExportingRef.current = false
      setTimeout(() => setReportExportStatus(""), 6000)
    }
  }

  /* 工作区全屏（用户需求：目录+正文+AI 助手三栏一起铺满，大画布直接改标书/调格式）。
     切换只改同一容器的 CSS 类——条件渲染会重挂载 contenteditable，未保存的编辑与光标会随
     innerHTML 重设丢失。Esc 退出。 */
  const [editorFullscreen, setEditorFullscreen] = useState(false)
  useEscapeClose(() => setEditorFullscreen(false), editorFullscreen)

  /* 弹窗统一 Escape 关闭 */
  useEscapeClose(() => setExportConfirm(false), exportConfirm)
  useEscapeClose(() => setReportOpen(false), reportOpen)
  useEscapeClose(() => setCheckConfirm(null), checkConfirm !== null)

  // 无进行中项目：只引导上传，不渲染任何示例内容
  if (!projectId)
    return (
      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <FlowNav current="content" info={info} />
        <NoProjectGuide />
      </div>
    )

  // 项目数据加载中（含大标书 1MB 级读标结果，拉取要数秒）：先显示加载态——
  // 数据未就绪时绝不裸露计费按钮（用户会当成"还没生成"误触发重跑）。
  if (!info)
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 sm:py-7">
        <FlowNav current="content" info={info} />
        <StepPlaceholder text="正在加载项目…" delayMs={250} />
      </div>
    )

  // 项目加载中 / 提纲缺失（章节树依赖 outline 结果）→ 占位引导
  if (!active)
    return (
      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <FlowNav current="content" info={info} />
        <StepBanner
          running={running}
          error={error}
          runningText={contentRunningText}
          onRetry={() => void startContent()}
          action={errorAction ?? undefined}
        />
        {outlineLoading || dataLoading ? (
          <StepPlaceholder text={dataLoading ? "正在加载正文数据…" : "正在加载提纲章节…"} delayMs={250} />
        ) : outlineError ? (
          <StepPlaceholder text="提纲数据加载失败，请刷新重试" />
        ) : stepNotApplicable(info, "content") ? (
          /* 审查专用项目没有正文步：原来会引导去「提纲页」，而提纲页对这类项目说的是
             「不含提纲/正文生成」——两页互相指，用户绕不出去（反馈：逻辑混乱） */
          <StepPrereqGuide
            prereq={stepNotApplicable(info, "content")!}
            title="本项目不含正文生成"
            currentDesc="这是独立的标书审查项目（上传的线下标书），只做废标体检与述标，不走提纲/正文生成流水线。"
          />
        ) : stepPrereq(info, "content") ? (
          <StepPrereqGuide
            prereq={stepPrereq(info, "content")!}
            currentDesc="投标正文由 AI 按提纲章节逐章撰写——需要先生成提纲，确定技术标/商务标的章节结构"
          />
        ) : (
          <StepPlaceholder text="先完成提纲步骤，生成章节结构后再撰写正文" action={{ href: "/outline", label: "前往提纲页" }} />
        )}
      </div>
    )

  // 正文结果仍在途(提纲小结果先到、正文大结果后到):必须拦在编辑器渲染前——
  // 否则整棵章节树显示"待生成"空章(用户以为文档丢了),且此窗口内的编辑会被结果落地时重建覆盖。
  if (dataLoading)
    return (
      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <FlowNav current="content" info={info} />
        <StepPlaceholder text="正在加载正文数据…" delayMs={250} />
      </div>
    )

  // 正文步已就绪但未生成：停在显式生成入口（明示消耗），点击才计费开跑
  const needsRun = info?.project.currentStep === "content" && !realBodies && !running

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-[1600px] flex-col px-4 py-5 sm:px-6 lg:px-8">
      <FlowNav current="content" info={info} />
      <StepBanner
        running={running}
        error={error}
        runningText={contentRunningText}
        onRetry={() => void startContent()}
        action={errorAction ?? undefined}
      />
      {isReal && missingChapters.length > 0 && (
        <div className="mb-3 flex flex-col gap-3 rounded-2xl border border-warning/30 bg-warning/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">
              还有 {missingChapters.length} 章未生成
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {filling
                ? `正在补写第 ${filling.done + 1}/${filling.total} 章…`
                : fillError || "正文生成中断时会留下待生成的章节，可在此一键补齐（不消耗积分，已写好的章不会被重写）"}
            </p>
          </div>
          <button
            onClick={() => void draftChapters(missingChapters)}
            disabled={!!filling}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Sparkles className="size-4" />
            {filling ? "补写中…" : "补齐缺失章节"}
          </button>
        </div>
      )}
      {needsRun && (
        <div className="mb-3 flex flex-col gap-3 rounded-2xl border border-primary/20 gradient-brand-soft px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">投标正文尚未生成</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              AI 按提纲逐章撰写（{contentCostText}），生成后可在线编辑
            </p>
          </div>
          <button
            onClick={() => setGenConfigOpen(true)}
            disabled={!tiersConfigured}
            title={contentCtaBlockedReason}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Sparkles className="size-4" />
            生成投标正文
          </button>
        </div>
      )}
      <StepPageHeader icon={FileText} title="标书生成" desc="AI 逐章生成标书正文，支持在线编辑与对话润色，完成后一键导出">
        <div className="flex items-center gap-3">
          {/* 技术标 / 商务标 / 标书全文 切换 */}
          <div className="inline-flex rounded-xl border border-border bg-card p-1">
            {bidTabs.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === bidType
              return (
                <button
                  key={tab.id}
                  onClick={() => switchBid(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? "gradient-brand text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4" />
                  {tab.name}
                </button>
              )
            })}
          </div>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="hidden items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
          >
            {chatOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            AI 助手
          </button>
        </div>
      </StepPageHeader>
      <AiNotice className="shrink-0" />

      {/* 三栏工作区；全屏时同一容器改为 fixed 铺满视口（目录/正文/AI 助手一起放大） */}
      <div
        className={`${
          editorFullscreen ? "fixed inset-0 z-[85] grid gap-4 overflow-auto bg-background p-4" : "mt-4 grid min-h-0 flex-1 gap-4"
        } ${
          // 窄视口（小屏/页面放大）三栏收紧,编辑器保底;xl 以上恢复宽松布局
          chatOpen
            ? "lg:grid-cols-[200px_minmax(0,1fr)_280px] xl:grid-cols-[260px_minmax(0,1fr)_340px]"
            : "lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]"
        }`}
      >
        {/* 左：目录 */}
        <ChapterNav
          groups={groups}
          activeId={active.id}
          generatedCount={generatedCount}
          total={list.length}
          onSelect={selectChapter}
          fullDoc={bidType === "full"}
        />

        {/* 中：可编辑正文 */}
        <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="mr-1 shrink-0 text-xs font-medium text-primary">{active.no}</span>
            {/* min-w-0：flex 子项默认不肯收缩，长标题会把工具栏挤断行（全屏按钮曾被单独挤成一行） */}
            <span className="mr-auto min-w-0 truncate text-sm font-semibold text-foreground" title={active.title}>{active.title}</span>
            {/* 编辑工具栏（含全屏切换：目录/正文/AI 助手三栏一起铺满，Esc 退出） */}
            <EditorToolbar
              editor={editor}
              onUndo={undoChapter}
              onOpenLibrary={openLibrary}
              onInsertImage={openImagePicker}
              fullscreen={editorFullscreen}
              onToggleFullscreen={() => setEditorFullscreen((v) => !v)}
            />
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onImageChosen(e)} />
          </div>

          {active.html.trim() ? (
            <RichEditor
              key={`${active.id}:${editorEpoch}`}
              /* 装载时与提纲对齐（剥内嵌旧章标题/编号跟随章号，与导出同规则）：只影响用户
                 打开的这一章，编辑保存后自然收敛——绝不在建树时改写未打开章（整份回写会把
                 未经用户过目的改动落库，评审 F5） */
              html={normalizeChapterHtml(stripDocumentShell(active.html), active.no, active.title, active.id)}
              scrollRef={editorScrollRef}
              onBlurSave={saveEditor}
              onEditor={setEditor}
              contentClass="prose-sm min-w-0 break-words px-6 py-5 text-sm leading-relaxed text-foreground outline-none [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-1.5 [&_h4]:mt-3.5 [&_h4]:text-sm [&_h4]:font-semibold [&_h5]:mb-1 [&_h5]:mt-3 [&_h5]:text-sm [&_h5]:font-medium [&_h6]:mb-1 [&_h6]:mt-2.5 [&_h6]:text-sm [&_h6]:font-medium [&_h6]:text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:break-words [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td]:break-words"
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="size-6 text-primary" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">本章节正文尚未生成</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                {active.sourced
                  ? "该章节对应招标文件要求，点击下方按钮由 AI 生成初稿后即可编辑。"
                  : "该章节为提纲新增内容，招标文件中无直接对应，建议结合自身情况补写。"}
              </p>
              {isReal ? (
                /* 正文已生成但本章为空：直接补写本章（走单章通道，不消耗积分）。
                   此前这里只写一句"去右侧 AI 助手输入指令"，而那条路当时对**从未生成过的章**
                   根本不通——请求在调模型之前就被拒了，用户只看到「改写失败，请稍后重试」。 */
                <div className="mt-5 flex flex-col items-center gap-2">
                  <button
                    onClick={() => void draftChapters([active])}
                    disabled={!!filling}
                    className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <Sparkles className="size-4" />
                    {filling ? "补写中…" : "生成本章正文"}
                  </button>
                  <span className="text-[11px] text-muted-foreground">不消耗积分；也可在右侧 AI 助手输入具体要求</span>
                </div>
              ) : (
                /* 正文步未跑：指向顶部显式生成入口（生成中由顶部横幅提示进度） */
                <p className="mt-5 max-w-xs rounded-xl border border-primary/20 gradient-brand-soft px-4 py-2.5 text-xs leading-relaxed text-primary">
                  {running ? "正文生成中，完成后本章自动填充" : "点击上方「生成投标正文」按钮，由 AI 撰写全部章节初稿"}
                </p>
              )}
            </div>
          )}

          {active.html.trim() && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5" />
                重写本章可在右侧 AI 助手输入指令（不消耗积分）
              </span>
              <span className="text-xs text-muted-foreground">
                · 本章约 {fmtChars(activeChars)} 字 · 约 {activePages} 页
              </span>
              <span
                className={`ml-auto text-xs ${contentSaveState === "error" ? "font-medium text-destructive" : "text-muted-foreground"}`}
              >
                {!isReal
                  ? "编辑后自动保存"
                  : contentSaveState === "saving"
                    ? "保存中…"
                    : contentSaveState === "error"
                      ? contentSaveError || "保存失败，编辑后将自动重试"
                      : contentSaveState === "saved"
                        ? "已保存"
                        : "编辑后自动保存"}
              </span>
            </div>
          )}
        </section>

        {/* 右：AI 对话（真实项目走单章改写通道） */}
        {chatOpen && (
          <ChatPanel
            chapters={fullList().map((c) => ({ id: c.id, no: c.no, title: c.title }))}
            activeId={active.id}
            projectId={projectId}
            contentReady={isReal}
            balance={balance}
            onApply={applyRewrite}
            refreshBalance={reloadMembership}
            onOpenLibrary={openLibrary}
          />
        )}
      </div>

      {/* 底部：废标体检 + 导出文件 */}
      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        {/* 当前积分余额（真实值；导出等操作按积分消耗）；加载中显示占位，失败给可见提示 */}
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          <Coins className="size-3" />
          余额：{membershipLoading ? "…" : `${balance} 积分`}
          {membershipError && <span className="text-destructive">{membershipError}</span>}
        </span>

        <div className="flex flex-wrap items-center gap-3">
          {hasExported && (
            <span className="hidden text-xs text-muted-foreground lg:inline">导出后可在「我的标书」随时重新下载</span>
          )}
          {exportStatus && <span className="text-xs font-medium text-primary">{exportStatus}</span>}
          {/* 步序闸 / 积分不足提示：说明还差哪些步骤（含费用），附入口链接 */}
          {exportGate && (
            <span className="text-xs font-medium text-destructive">
              {exportGate.text}
              <Link href={exportGate.href} className="ml-1.5 font-semibold text-primary underline">
                {exportGate.label}
              </Link>
            </span>
          )}

          {hasExported && (
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <FileText className="size-4" />
              我的标书
            </Link>
          )}

          {/* 下载区（2026-08-09 export-scope）：已产出的分册直接再下载，不用回导出弹窗重渲。
              终审 C1：过期的册（内容改过、该册没重新导出过）禁用直下——绝不悄悄发旧文件；
              要拿新版只能走「导出」按钮，进弹窗显式确认（可能计费）后再重渲，不在这里的点击里发生。 */}
          {scopedDownloadItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {scopedDownloadItems.map((d) => (
                <button
                  key={d.key}
                  onClick={() => void redownload(d.kind)}
                  disabled={d.stale}
                  title={d.stale ? "内容已修改，重新导出后可下载" : undefined}
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card"
                >
                  <Download className="size-3" />
                  {d.text}
                </button>
              ))}
            </div>
          )}

          {/* 一键废标体检（真实项目跑 review 步；content 未完成时禁用） */}
          <div className="relative">
            <button
              onClick={() => void onCheckClick()}
              disabled={checkState === "checking" || !canCheck}
              title={!canCheck ? "完成正文生成后可体检" : undefined}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                checkState === "done" && (healthCheck?.high ?? 0) > 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                  : checkState === "done"
                    ? "border-success/40 bg-success/10 text-success hover:bg-success/15"
                    : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {checkState === "checking" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  体检中…（跑真实审查，约 1–2 分钟）
                </>
              ) : checkState === "done" && healthCheck ? (
                healthCheck.high > 0 ? (
                  <>
                    <ShieldAlert className="size-4" />
                    {healthCheck.high} 项高风险
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-4" />
                    体检通过
                  </>
                )
              ) : (
                <>
                  <ShieldCheck className="size-4" />
                  {/* 计费告知：真实项目首次体检显示消耗（已有结果时开合免费） */}
                  一键废标体检{isReal && !findings ? `（${reviewCost} 积分）` : ""}
                </>
              )}
            </button>
            {checkState !== "checking" && checkError && (
              <span className="absolute -top-5 right-0 whitespace-nowrap text-[11px] font-medium text-destructive">
                {checkError}
                {checkErrorStatus === 402 && (
                  <Link href="/membership" className="ml-1 font-semibold text-primary underline">
                    去充值
                  </Link>
                )}
              </span>
            )}

            {/* 体检结果摘要弹层 */}
            {checkOpen && checkState === "done" && healthCheck && (
              <CheckSummary
                report={healthCheck}
                onClose={() => setCheckOpen(false)}
                onOpenReport={openReport}
              />
            )}
          </div>

          {/* 导出文件 */}
          <div className="relative">
            {/* 体检/导出在途时置灰并显示状态——在途仍可点是怪设计（用户反馈），且防重复触发 */}
            <button
              onClick={onExportEntry}
              disabled={membershipLoading || !projectId || exporting || checkState === "checking"}
              title={!projectId ? "请先从项目进入" : undefined}
              className="inline-flex items-center gap-2 rounded-xl gradient-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="size-4" />
              {membershipLoading
                ? "余额加载中…"
                : checkState === "checking"
                  ? "体检进行中…"
                  : exporting
                    ? "导出中…"
                    : "导出文件"}
            </button>

            {/* 导出菜单（积分不足时已走付费墙，不会展开） */}
            {exportOpen && canAfford && (
              <ExportMenu
                scope={exportScope}
                format={exportFormat}
                cost={exportCost}
                balance={balance}
                pdfUnavailable={pdfUnavailable}
                freeRerender={freeRerender}
                availability={scopeAvail}
                preview={preview}
                projectId={projectId}
                onScope={setExportScope}
                onFormat={setExportFormat}
                onConfirm={() => void attemptExport()}
                onClose={() => setExportOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* 体检计费确认（体检按钮 / 确认导出两个入口共用；跳过导出仅步序闸允许时提供） */}
      {checkConfirm && (
        <CheckConfirm
          cost={reviewCost}
          balance={balance}
          skip={
            checkConfirm === "export" && !exportGateHint()
              ? {
                  label: "跳过体检直接导出",
                  onSkip: () => {
                    setCheckConfirm(null)
                    doExport(exportFormat)
                  },
                }
              : undefined
          }
          onConfirm={() => void confirmCheck()}
          onClose={() => setCheckConfirm(null)}
        />
      )}

      {/* 导出前高风险二次确认 */}
      {exportConfirm && healthCheck && (
        <ExportConfirm
          report={healthCheck}
          onViewReport={openReport}
          onExportAnyway={() => {
            setSoftPassed(true)
            setExportConfirm(false)
            doExport(exportFormat)
          }}
          onClose={() => setExportConfirm(false)}
        />
      )}

      {/* 就地完整体检报告（针对当前这份标书草稿） */}
      {reportOpen && healthCheck && (
        <ReportDialog
          report={healthCheck}
          exportStatus={reportExportStatus}
          chapterIds={allChapterIds}
          onClose={() => setReportOpen(false)}
          onGoto={gotoChapter}
          onExportReport={exportReport}
          onExportBid={exportBidFromReport}
        />
      )}

      {/* 从资料库插入选择器（数据由页面级 useLibrary 提供） */}
      {genConfigOpen && (
        <GenerationConfigDialog
          chapterCount={[...data.tech, ...data.business].length || 10}
          projectId={projectId}
          info={info}
          costText={contentCostText}
          onConfirm={({ targetChars }) => {
            setGenConfigOpen(false)
            void startContent({ targetChars }) // format 不随本请求走:存 localStorage,导出时由 use-export 读取下发
          }}
          onClose={() => setGenConfigOpen(false)}
        />
      )}

      {libraryOpen && (
        <LibraryPicker
          items={libItems}
          loading={libLoading}
          error={libError}
          onClose={() => setLibraryOpen(false)}
          onPick={insertFromLibrary}
          busy={libraryBusy}
        />
      )}
    </div>
  )
}
