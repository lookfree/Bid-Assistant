"use client"

import { useEffect, useRef, useState } from "react"
import { ApiError } from "@/lib/api-client"
import { artifactDownload, triggerDownload, runStep, StreamIncompleteError, type ProjectInfo } from "@/lib/project"
import { storedFormat } from "@/lib/generation-config"
import { notifyCreditsChanged, pollStepResult, useOtherStepResult } from "@/lib/use-step"
import type { RealRisk } from "@/lib/risk-derive"

/** 步序闸 / 402 引导提示（区别于 3 秒即逝的 exportStatus）。 */
export type ExportGate = { text: string; href: string; label: string }

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

  // spec323：已跑过 export 步且结果无 pdf key ⇒ 该次 docx→pdf 转换失败（agent best-effort），PDF 选项置灰
  const { data: exportedResult } = useOtherStepResult<{ pdf?: string }>(projectId, info, "export")
  const pdfUnavailable = !!exportedResult && !exportedResult.pdf
  // 已知不可用时把停留在 pdf 的选择拨回 word，避免「已禁用但仍被选中」的怪状态
  useEffect(() => {
    if (pdfUnavailable) setExportFormat((f) => (f === "pdf" ? "word" : f))
  }, [pdfUnavailable])

  function flashExportStatus(text: string) {
    setExportStatus(text)
    setTimeout(() => setExportStatus(""), 3000)
  }

  /** 真实页数后缀（agent 导出时用 PDF 数出的地面真值,artifacts.pdfPages）。
   *  从手头已有的 export 结果读（评审 F5:再发一次网络请求既多付一个 RTT,挂住还会卡死 finally）。 */
  const pagesSuffix = (r: { pdfPages?: number } | null | undefined): string =>
    typeof r?.pdfPages === "number" && r.pdfPages > 0 ? `（实际 ${r.pdfPages} 页）` : ""

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

  /** 正文/提纲发生实际变更：下次导出重新按「要收费」显示（服务端已同步置脏）。 */
  function markContentChanged() {
    setLocalClean(false)
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
    const kind = format === "pdf" ? "pdf" : "docx"
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
        const exportRes = (await runStep(projectId, "export", undefined, fmt ? { format: fmt } : undefined)) as {
          pdfPages?: number
        } | null
        const dl = await artifactDownload(projectId, kind)
        triggerDownload(dl.url)
        setExportStatus(`已开始下载《${dl.filename}》${pagesSuffix(exportRes)}，可在浏览器「下载」列表查看`)
        setLocalClean(true)
      } catch (e) {
        // 连接中途断开 / 双发撞 running / 撞上对账刚收尾（step_already_done）：run 在服务端照常
        // 跑或已完成——转收敛轮询等真实结果,绝不把切页断流误报成「导出失败」诱导重跑重扣。
        const converge =
          e instanceof StreamIncompleteError ||
          (e instanceof ApiError && e.status === 409 &&
            (e.code === "step_already_running" || e.code === "step_already_done"))
        if (converge) {
          try {
            const converged = (await pollStepResult(projectId, "export")) as { pdfPages?: number } | null
            notifyCreditsChanged()
            const dl = await artifactDownload(projectId, kind)
            triggerDownload(dl.url)
            setExportStatus(`已开始下载《${dl.filename}》${pagesSuffix(converged)}，可在浏览器「下载」列表查看`)
            setLocalClean(true)
            return
          } catch (e2) {
            // 收敛成功但 pdf 产物缺失（该次 docx→pdf 转换失败）:导出步其实成功了,给准确文案
            setExportStatus(
              kind === "pdf" && e2 instanceof ApiError && e2.status === 404
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
        } else if (kind === "pdf" && e instanceof ApiError && e.status === 404) {
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

  return {
    exportOpen, setExportOpen,
    exportFormat, setExportFormat,
    exportStatus, flashExportStatus,
    exportGate, exportGateHint,
    hasExported, pdfUnavailable, exporting, freeRerender, markContentChanged,
    onExportEntry, attemptExport, doExport,
  }
}
