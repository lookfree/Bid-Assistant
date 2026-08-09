"use client"

import { useEffect, useRef, useState } from "react"
import { ApiError } from "@/lib/api-client"
import {
  artifactDownload,
  exportPreview,
  triggerDownload,
  runStep,
  StreamIncompleteError,
  type ExportPreview,
  type ProjectInfo,
} from "@/lib/project"
import { storedFormat } from "@/lib/generation-config"
import { notifyCreditsChanged, pollStepResult, useOtherStepResult } from "@/lib/use-step"
import type { RealRisk } from "@/lib/risk-derive"
import { artifactKeys, type ExportScope } from "@/lib/export-scope"

/** 步序闸 / 402 引导提示（区别于 3 秒即逝的 exportStatus）。 */
export type ExportGate = { text: string; href: string; label: string }

// export 步结果快照（已经 App 层 toCamel）：全量键 docx/pdf/pdfPages 不变，分册键随 scope 走
// docxTech/pdfTech/pdfPagesTech、docxBiz/pdfBiz/pdfPagesBiz——与 lib/export-scope.ts 的
// artifactKeys()（下载路由用的 snake_case 键）是两套大小写，靠 camelArtifactKey 对应。
export type ExportArtifacts = Record<string, string | number | undefined>

/** scope → 该 artifact 在 toCamel 后的字段名（下载路由用 artifactKeys 的 snake_case，这里是它的
 *  camelCase 版本，供读 exportedResult 判断"该册是否已产出"用）。 */
export function camelArtifactKey(scope: ExportScope, base: "docx" | "pdf" | "pdfPages"): string {
  const sfx = scope === "tech" ? "Tech" : scope === "business" ? "Biz" : ""
  return `${base}${sfx}`
}

/** PDF 选项是否该置灰（终审 I1）：仅当该 scope 已产出 docx（导过）但 pdf 缺失/为 null（agent 侧
 *  soffice 转换失败）时才置灰——「导过但转不出 PDF」与「这册压根没导过」是两回事，此前只看
 *  「pdf 键不存在」，会把从未导出过的册也一并置灰，堵死分册 PDF 的首次导出。 */
export function pdfUnavailableFor(exported: ExportArtifacts | null | undefined, scope: ExportScope): boolean {
  if (!exported) return false
  const hasDocx = !!exported[camelArtifactKey(scope, "docx")]
  const hasPdf = !!exported[camelArtifactKey(scope, "pdf")]
  return hasDocx && !hasPdf
}

/** 导出全流程 hook（从 content/page.tsx 拆出,页面超 800 行拆分）：
 *  入口付费墙 → 体检确认/高风险二次确认（弹层仍在页面,这里回调发信号）→ export 步执行
 *  → 断流收敛（StreamIncomplete/409 转轮询,绝不误报失败诱导重扣）→ 断点续看（切页回来
 *  检出服务端 running 的 export 行,恢复提示并等完成）。 */
export function useExport(opts: {
  projectId: string | null
  info: ProjectInfo | null
  membershipLoading: boolean
  canAfford: boolean
  openPaywall: () => void
  canCheck: boolean
  isReal: boolean
  findings: RealRisk | null
  checkState: "idle" | "checking" | "done"
  runCheck: () => Promise<RealRisk | null>
  softPassed: boolean
  /** 体检未跑：页面弹计费确认（checkConfirm="export"） */
  requestCheckConfirm: () => void
  /** 体检有高风险且未软放行：页面弹二次确认（exportConfirm） */
  onHighRisk: () => void
}) {
  const { projectId, info } = opts
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<"word" | "pdf">("word")
  // 导出范围三选一（2026-08-09 export-scope）：全量/技术标册/商务标册，默认全量（老行为不变）。
  const [exportScope, setExportScope] = useState<ExportScope>("full")
  const [exportStatus, setExportStatus] = useState<string>("")
  const [exportGate, setExportGate] = useState<ExportGate | null>(null)
  // 本地净态：导出成功置 true，正文一变置 false（null=还没有本地判断，听服务端的）。
  // 不能用「导出过就永远免费」的粘滞布尔——info 只在挂载时取一次，
  // 「导出→改正文→再导出」会一直沿用导出那刻的免费判断，界面写着不消耗积分而服务端照扣。
  const [localClean, setLocalClean] = useState<boolean | null>(null)
  const hasExported = localClean === true
  // 导出在途（含从导出流程触发的体检等待）：驱动导出按钮置灰——体检/渲染中按钮仍可点是怪设计（用户反馈）。
  // ref 是同步防重（state 异步，双击间隙读到旧值）；state 供 UI 渲染。
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)

  // spec323：已跑过 export 步且**本次 scope** 的产物有 docx 无 pdf key ⇒ 该次 docx→pdf 转换失败
  // （agent best-effort），PDF 选项置灰。2026-08-09 分册起 pdf 键随 scope 走，不能再固定读 pdf——
  // 否则技术册转换失败时会被商务册仍在的 pdf 键误判成"可用"。终审 I1：必须先看 docx 键是否存在——
  // 该 scope 从未导出过时 docx/pdf 键都没有，此前只看"pdf 键不存在"会把它也一并置灰，堵死首次导出。
  // exportRefetchToken（主#14）：export 步一直是 done、useOtherStepResult 靠 done 翻转重取的
  // 默认口径接不住"同一个 done 步又跑出新产物"——本会话内每导出成功一次自增一次，强制重取
  // 最新快照，下载区/PDF 置灰判断才跟得上刚产出的这版，不必等整页刷新。
  const [exportRefetchToken, setExportRefetchToken] = useState(0)
  const { data: exportedResult } = useOtherStepResult<ExportArtifacts>(projectId, info, "export", exportRefetchToken)
  const pdfUnavailable = pdfUnavailableFor(exportedResult, exportScope)
  // 已知不可用时把停留在 pdf 的选择拨回 word，避免「已禁用但仍被选中」的怪状态
  useEffect(() => {
    if (pdfUnavailable) setExportFormat((f) => (f === "pdf" ? "word" : f))
  }, [pdfUnavailable])

  // 导出预告（spec 方案A）：项目就绪即取一次（不再只等弹窗打开）——终审 C1 起，preview.volumes/
  // content_changed_at 还要喂给页面常驻的下载区（与弹窗是否开过无关，导出完就可能立刻显示按钮），
  // 只在开弹窗时才取会让首屏下载按钮读到旧数据、误判"未过期"。弹窗每次打开仍重取一次保证新鲜
  // （exportOpen 仍在依赖数组里）；失败静默——预告区只少资质那一行，下载区退化为不置灰，不挡导出。
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  useEffect(() => {
    if (!projectId) return
    let alive = true
    exportPreview(projectId)
      .then((r) => { if (alive) setPreview(r) })
      .catch(() => {})
    return () => { alive = false }
  }, [projectId, exportOpen])

  function flashExportStatus(text: string) {
    setExportStatus(text)
    setTimeout(() => setExportStatus(""), 3000)
  }

  /** 导出成功后刷新「过期门」的两侧依据（主#14 双向修的后半——导出侧）：重取 export-preview
   *  换新 volumes/content_changed_at，并推 exportRefetchToken 逼 exportedResult 重取最新产物
   *  快照。刚导完的册不能再被下载区判成"内容已修改"而置灰——那正是过期门要拦的场景，不能
   *  连自己刚产出的这版也拦。失败静默：不影响本次已经在 doExport 里处理过的下载/提示。 */
  function refreshAfterExport() {
    if (!projectId) return
    setExportRefetchToken((t) => t + 1)
    exportPreview(projectId).then((r) => setPreview(r)).catch(() => {})
  }

  /** 真实页数后缀（agent 导出时用 PDF 数出的地面真值,artifacts.pdfPages，分册键随 scope 走）。
   *  从手头已有的 export 结果读（评审 F5:再发一次网络请求既多付一个 RTT,挂住还会卡死 finally）。 */
  const pagesSuffix = (r: ExportArtifacts | null | undefined, scope: ExportScope): string => {
    const v = r?.[camelArtifactKey(scope, "pdfPages")]
    return typeof v === "number" && v > 0 ? `（实际 ${v} 页）` : ""
  }

  /** 本次导出服务端是否免费（口径见 services/export-dirty.ts）：内容改过就收费，
   *  未改动的重复下载免费。必须与服务端同口径——前端若仍按旧的「导出过就免费」判断，
   *  用户改完正文、余额为 0 时会跳过付费墙直奔 402，只看到一句「导出失败」。
   *  并上本会话的 hasExported：info 走 30s 缓存，刚导出完那次不至于还显示要扣费。
   *  字段缺失（老接口）时按收费处理——宁可多显示一次费用，也不误显示免费。 */
  const freeRerender = localClean ?? info?.project.exportDirty === false

  function onExportEntry() {
    // 余额加载中不做付费墙判定（按钮已禁用，双保险防按 balance=0 误弹）
    if (opts.membershipLoading) return
    setExportGate(null)
    // 积分不足：弹「开通会员」付费墙；重渲免费则不设门（积分不足也放行）
    if (!freeRerender && !opts.canAfford) {
      opts.openPaywall()
      return
    }
    setExportOpen((v) => !v)
  }

  /** 步序闸：export 在废标审查完成后即可跑——述标（present）已是独立可选步，agent 图有
      review→export 条件边直达，不再要求先完成述标。currentStep 早于 review 完成时不调
      runStep("export")（后端必 409），给完成路径提示。 */
  function exportGateHint(): ExportGate | null {
    const cur = info?.project.currentStep
    // review 起即可导出：废标体检可跳过（用户口径「不能跳过废标体检直接导出，希望能跳过，省积分」）——
    // 后端步序闸同步放行。仍未走到 review（正文没生成完）才拦，那是真的没东西可导。
    if (!cur || ["review", "present", "export", "done"].includes(cur)) return null
    return { text: "导出前需完成：标书正文生成", href: "/content", label: "前往正文页" }
  }

  /** 正文/提纲发生实际变更：下次导出重新按「要收费」显示（服务端已同步置脏）。
   *  主#14 双向修的前半——保存/改写侧：下载区的过期门单独读 preview.content_changed_at，
   *  它只在 [projectId, exportOpen] 变化时重取；这一刻不开关导出弹窗的话，这个字段会停在
   *  上一次生成/导出那一刻，下载区就不知道内容又变了，过期的册反而显示"可直下"。本地把它
   *  推进到"现在"比等一次网络往返更可靠，也不因请求失败而错过（page.tsx:819 的铁律：过期的
   *  册禁用直下——绝不悄悄发旧文件）。 */
  function markContentChanged() {
    setLocalClean(false)
    setPreview((p) => (p ? { ...p, content_changed_at: new Date().toISOString() } : p))
  }

  /* 付费用户在导出菜单点「确认导出」：体检未跑不再静默触发，先显式确认计费；再按风险弱拦截 */
  async function attemptExport() {
    setExportOpen(false)
    if (exportingRef.current || opts.checkState === "checking") return // 在途防重（按钮已置灰，双保险）
    if (!opts.canCheck) {
      flashExportStatus("完成正文生成后可体检并导出")
      return
    }
    // 体检未跑（review 步无结果）：弹计费确认，用户显式确认或跳过（跳过仅步序闸允许时可选）
    if (opts.isReal && !opts.findings) {
      opts.requestCheckConfirm()
      return
    }
    const f = opts.checkState === "done" ? opts.findings : await opts.runCheck()
    if (!f) {
      flashExportStatus("体检失败，请重试")
      return
    }
    if (f.high > 0 && !opts.softPassed) {
      opts.onHighRisk()
    } else {
      doExport(exportFormat)
    }
  }

  function doExport(format: "word" | "pdf") {
    setExportOpen(false)
    setExportGate(null)
    if (exportingRef.current) return // 同步防重：渲染/下载在途时忽略重复触发
    // 只有真实项目才可导出（导出按钮无项目时已禁用；报告弹层等入口在此兜底提示）
    if (!projectId || !info) {
      flashExportStatus("请先从项目进入，再导出标书文件")
      return
    }
    // 步序闸：还没走到 export 步就不发请求，给出完成路径与入口链接
    const gate = exportGateHint()
    if (gate) {
      setExportGate(gate)
      return
    }
    // 真实导出：export 步（渲染完整 .docx，best-effort 转 .pdf，落 MinIO）→ 预签名 URL 直下
    // 2026-08-09 分册：产物键随 exportScope 走后缀（docx_tech/pdf_biz…），下面判断 PDF 专属文案
    // 一律看 format（三种 scope 下都是字面量 "word"|"pdf"），不能再看 kind（scope≠full 时它不是 "pdf"）。
    const keys = artifactKeys(exportScope)
    const kind = format === "pdf" ? keys.pdf : keys.docx
    exportingRef.current = true
    setExporting(true)
    setExportStatus(format === "pdf" ? "正在渲染完整标书（PDF）…" : "正在渲染完整标书…")
    void (async () => {
      try {
        // 每次导出都按**当前**正文重渲（用户口径 2026-07-28）：此前是「export 步已有结果且
        // 格式指纹没变 → 跳过重跑,直接下载 MinIO 里的旧文件」,于是在线编辑、AI 改写（25 积分/次）、
        // 提纲顺序调整、渲染器升级全都拿不到——用户可能拿着不含自己修改的标书去投标。
        // 导出是确定性渲染（无 LLM）,重渲只花本机 CPU,服务端对重渲也不再计费,故一律重跑。
        const fmt = storedFormat()
        const exportRes = (await runStep(
          projectId,
          "export",
          undefined,
          { ...(fmt ? { format: fmt } : {}), export_scope: exportScope },
        )) as ExportArtifacts | null
        const dl = await artifactDownload(projectId, kind)
        triggerDownload(dl.url)
        setExportStatus(`已开始下载《${dl.filename}》${pagesSuffix(exportRes, exportScope)}，可在浏览器「下载」列表查看`)
        setLocalClean(true)
        refreshAfterExport()
      } catch (e) {
        // 连接中途断开 / 双发撞 running / 撞上对账刚收尾（step_already_done）：run 在服务端照常
        // 跑或已完成——转收敛轮询等真实结果,绝不把切页断流误报成「导出失败」诱导重跑重扣。
        const converge =
          e instanceof StreamIncompleteError ||
          (e instanceof ApiError && e.status === 409 &&
            (e.code === "step_already_running" || e.code === "step_already_done"))
        if (converge) {
          try {
            const converged = (await pollStepResult(projectId, "export")) as ExportArtifacts | null
            notifyCreditsChanged()
            const dl = await artifactDownload(projectId, kind)
            triggerDownload(dl.url)
            setExportStatus(`已开始下载《${dl.filename}》${pagesSuffix(converged, exportScope)}，可在浏览器「下载」列表查看`)
            setLocalClean(true)
            refreshAfterExport()
            return
          } catch (e2) {
            // 收敛成功但 pdf 产物缺失（该次 docx→pdf 转换失败）:导出步其实成功了,给准确文案
            setExportStatus(
              format === "pdf" && e2 instanceof ApiError && e2.status === 404
                ? "PDF 生成失败，仅提供 Word"
                : "导出失败，请重试",
            )
            return
          }
        }
        // 错误码直通：402 引导充值（持久提示），409 步骤顺序，pdf 404=该次转换失败仅有 docx，其余通用重试
        if (e instanceof ApiError && e.status === 402) {
          setExportGate({ text: "积分不足，无法导出", href: "/membership", label: "去充值" })
          setExportStatus("")
        } else if (e instanceof ApiError && e.status === 409) {
          setExportStatus("步骤顺序不符，请先完成前序步骤")
        } else if (format === "pdf" && e instanceof ApiError && e.status === 404) {
          setExportStatus("PDF 生成失败，仅提供 Word")
        } else {
          setExportStatus("导出失败，请重试")
        }
      } finally {
        exportingRef.current = false
        setExporting(false)
        setTimeout(() => setExportStatus(""), 6000) // 成功提示含文件名，3 秒读不完
      }
    })()
  }

  // 断点续看（export）：导出中切页再回来,本地 exportStatus 早已丢失——从 slim info 检出
  // 服务端仍在 running 的 export 行,恢复「渲染中」提示并收敛等它完成(一次性,ref 防重)。
  const exportResumed = useRef(false)
  useEffect(() => {
    if (!projectId || exportResumed.current) return
    if (!info?.steps.some((s) => s.step === "export" && s.status === "running")) return
    exportResumed.current = true
    exportingRef.current = true
    setExporting(true)
    setExportStatus("正在渲染完整标书…")
    void (async () => {
      try {
        await pollStepResult(projectId, "export")
        notifyCreditsChanged()
        refreshAfterExport()
        setExportStatus("导出已完成，点击「导出」下载文件")
      } catch {
        setExportStatus("")
      } finally {
        exportingRef.current = false
        setExporting(false)
        setTimeout(() => setExportStatus(""), 5000)
      }
    })()
  }, [projectId, info])

  /** 下载区（已产出的某册再下载,不重渲、不再计费——直接按产物键取预签名地址）。 */
  async function redownload(kind: string) {
    if (!projectId) return
    try {
      const dl = await artifactDownload(projectId, kind)
      triggerDownload(dl.url)
      flashExportStatus(`已开始下载《${dl.filename}》，可在浏览器「下载」列表查看`)
    } catch {
      flashExportStatus("下载失败，请重试")
    }
  }

  return {
    exportOpen, setExportOpen,
    exportFormat, setExportFormat,
    exportScope, setExportScope,
    preview,
    exportedResult, redownload,
    exportStatus, flashExportStatus,
    exportGate, exportGateHint,
    hasExported, pdfUnavailable, exporting, freeRerender, markContentChanged,
    onExportEntry, attemptExport, doExport,
  }
}
