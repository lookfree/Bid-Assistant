"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FileType2,
  FileText as FileDoc,
  HelpCircle,
  ListChecks,
  Loader2,
  X,
} from "lucide-react"
import Link from "next/link"
import { CreditEstimate } from "@/components/credit-estimate"
import { ApiError } from "@/lib/api-client"
import { libraryMatch } from "@/lib/library"
import { creditCostValue } from "@/lib/membership-view"
import { currentProjectId, triggerDownload } from "@/lib/project"
import { useLibrary } from "@/lib/use-library"
import { useMembership } from "@/lib/use-membership"
import {
  exportChecklist,
  getChecklist,
  saveChecklist,
  type ChecklistItemState,
  type CheckStatus,
} from "@/lib/risk-api"

/* ---------------- 终极审核表（投递前清单）模板 ---------------- */
const checklistGroups: { id: string; title: string; items: string[] }[] = [
  {
    id: "A",
    title: "资格与资质",
    items: [
      "营业执照有效且经营范围覆盖",
      "招标要求资质证书齐全（如 ISO 体系 / 行业资质 / 安全生产许可）",
      "近三年类似业绩满足数量金额并附合同验收",
      "财务 / 审计报告满足",
      "未被列入失信被执行人 / 重大税收违法 / 政府采购严重违法失信名单",
      "社保与依法纳税证明齐全",
    ],
  },
  {
    id: "B",
    title: "投标保证金",
    items: [
      "金额与招标一致",
      "形式符合（转账 / 银行保函 / 电子保函）",
      "截止前到账且户名账号正确",
      "保函有效期覆盖投标有效期",
    ],
  },
  {
    id: "C",
    title: "签字与盖章",
    items: [
      "法定代表人签字盖章",
      "法人授权委托书（委托代理时）",
      "投标函 / 报价表 / 承诺函等关键页签章",
      "公章 / 骑缝章 / 每页章按要求",
      "复印件加盖公章并注明「与原件一致」",
    ],
  },
  {
    id: "D",
    title: "报价",
    items: [
      "唯一报价，无选择性 / 附条件",
      "不超过最高限价 / 预算",
      "不低于成本（避免恶意低价废标）",
      "大小写金额一致",
      "分项合计与总价一致，无算术错误",
      "报价表无漏项缺项",
    ],
  },
  {
    id: "E",
    title: "实质性响应（不可偏离★项）",
    items: [
      "带 ★ / ▲ 技术参数全部满足，无负偏离",
      "商务条款（工期 / 质保 / 付款）满足",
      "关键否决项逐条核对",
      "技术偏离表与商务偏离表如实填写",
    ],
  },
  {
    id: "F",
    title: "格式与完整性",
    items: [
      "按招标目录顺序编排",
      "正本 / 副本份数正确并标注",
      "电子版（U 盘 / 电子投标文件）齐全可读",
      "密封 / 装订 / 封面标识符合",
      "投标有效期满足",
    ],
  },
  {
    id: "G",
    title: "时间与递交",
    items: [
      "投标截止时间地点确认",
      "递交方式（现场 / 电子平台）确认",
      "关键证明材料（检测报告 / 认证 / 授权 / 样品）齐备",
    ],
  },
  {
    id: "H",
    title: "唯一性与合规",
    items: [
      "同一项目不重复投标",
      "无串标围标关联（可联动查重结果）",
      "联合体协议（如适用）齐全有效",
    ],
  },
]

const statusMeta: Record<CheckStatus, { label: string; badge: string; dot: string }> = {
  pass: { label: "通过", badge: "bg-success/10 text-success", dot: "bg-success" },
  risk: { label: "风险", badge: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
  pending: { label: "待确认", badge: "bg-warning/15 text-warning-foreground", dot: "bg-warning" },
}

type SaveState = "idle" | "saving" | "saved" | "error"

/** 三 map 合成持久化 items：仅收有实际内容的键（全默认的键不落库）。 */
function composeItems(
  statusMap: Record<string, CheckStatus>,
  ownerMap: Record<string, string>,
  noteMap: Record<string, string>,
): Record<string, ChecklistItemState> {
  const out: Record<string, ChecklistItemState> = {}
  const keys = new Set([...Object.keys(statusMap), ...Object.keys(ownerMap), ...Object.keys(noteMap)])
  for (const key of keys) {
    const status = statusMap[key] ?? "pending"
    const owner = ownerMap[key] ?? ""
    const note = noteMap[key] ?? ""
    if (status !== "pending" || owner || note) out[key] = { status, owner, note }
  }
  return out
}

/**
 * 审核表持久化 hook：挂载 GET 回填三 map；任一编辑防抖 800ms PUT 回写。
 * saveState 供 UI 渲染「保存中 / 已保存 / 保存失败」小状态。
 * 当前项目已不存在（GET 404，如本地残留已删项目 id）时自动降级为用户级默认行。
 */
function useChecklistPersistence(initialProjectId: string | null) {
  const [projectId, setProjectId] = useState(initialProjectId)
  const [statusMap, setStatusMap] = useState<Record<string, CheckStatus>>({})
  const [ownerMap, setOwnerMap] = useState<Record<string, string>>({})
  const [noteMap, setNoteMap] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const loadedRef = useRef(false) // 回填完成前不触发保存
  const skipSaveRef = useRef(false) // 回填本身引起的 map 变化不回写
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    loadedRef.current = false
    getChecklist(projectId)
      .then(({ items }) => {
        if (!alive) return
        const s: Record<string, CheckStatus> = {}
        const o: Record<string, string> = {}
        const n: Record<string, string> = {}
        for (const [key, it] of Object.entries(items ?? {})) {
          if (it.status && it.status !== "pending") s[key] = it.status
          if (it.owner) o[key] = it.owner
          if (it.note) n[key] = it.note
        }
        skipSaveRef.current = true
        setStatusMap(s)
        setOwnerMap(o)
        setNoteMap(n)
      })
      .catch((e: unknown) => {
        // 项目不存在/非本人 → 降级用户级默认行重载；其余失败按空白表处理，编辑仍可回写
        if (alive && projectId && e instanceof ApiError && e.status === 404) setProjectId(null)
      })
      .finally(() => {
        loadedRef.current = true
      })
    return () => {
      alive = false
    }
  }, [projectId])

  // 编辑防抖回写：map 变化 → 清旧计时器 → 800ms 后 PUT。
  useEffect(() => {
    if (!loadedRef.current) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSaveState("saving")
      saveChecklist(projectId, composeItems(statusMap, ownerMap, noteMap))
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"))
    }, 800)
  }, [statusMap, ownerMap, noteMap, projectId])

  return { projectId, statusMap, setStatusMap, ownerMap, setOwnerMap, noteMap, setNoteMap, saveState }
}

/* ============== 终极审核表 tab ============== */
export function Checklist() {
  /* 真实积分余额（导出预估用）与真实资料库条目（「资料库已具备」联动判定用） */
  const { overview, balance, reload } = useMembership()
  const { items: libItems } = useLibrary()
  const exportCost = creditCostValue(overview, "export", 20)
  const [initialProjectId] = useState<string | null>(() => currentProjectId())
  const { projectId, statusMap, setStatusMap, ownerMap, setOwnerMap, noteMap, setNoteMap, saveState } =
    useChecklistPersistence(initialProjectId)

  const allKeys = useMemo(() => checklistGroups.flatMap((g) => g.items.map((_, i) => `${g.id}-${i}`)), [])
  const total = allKeys.length
  const passedCount = allKeys.filter((k) => statusMap[k] === "pass").length
  const riskCount = allKeys.filter((k) => statusMap[k] === "risk").length
  const pendingCount = total - passedCount - riskCount

  function setStatus(key: string, s: CheckStatus) {
    setStatusMap((p) => ({ ...p, [key]: p[key] === s ? "pending" : s }))
  }

  return (
    <div className="flex flex-col gap-5">
      <ChecklistHeader
        passedCount={passedCount}
        total={total}
        riskCount={riskCount}
        pendingCount={pendingCount}
        saveState={saveState}
      />
      {checklistGroups.map((g) => (
        <GroupSection
          key={g.id}
          group={g}
          libItems={libItems}
          statusMap={statusMap}
          ownerMap={ownerMap}
          noteMap={noteMap}
          onStatus={setStatus}
          onOwner={(key, v) => setOwnerMap((p) => ({ ...p, [key]: v }))}
          onNote={(key, v) => setNoteMap((p) => ({ ...p, [key]: v }))}
        />
      ))}
      <ExportPanel
        cost={exportCost}
        balance={balance}
        projectId={projectId}
        statusMap={statusMap}
        ownerMap={ownerMap}
        noteMap={noteMap}
        libItems={libItems}
        onExported={reload}
      />
    </div>
  )
}

/* ---------------- 顶部说明 + 进度 ---------------- */
function ChecklistHeader({
  passedCount,
  total,
  riskCount,
  pendingCount,
  saveState,
}: {
  passedCount: number
  total: number
  riskCount: number
  pendingCount: number
  saveState: SaveState
}) {
  const progress = Math.round((passedCount / total) * 100)
  const saveLabel: Record<SaveState, string> = { idle: "", saving: "保存中…", saved: "已保存", error: "保存失败，继续编辑将自动重试" }
  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
            <ListChecks className="size-5 text-primary" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">投递前终极审核表</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              逐项核对并标注状态、责任人与备注，自动云端保存，完成后可导出签字版审核表存档
            </p>
            {saveState !== "idle" && (
              <p className={`mt-1 text-[11px] font-medium ${saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                {saveState === "saving" && <Loader2 className="mr-1 inline size-3 animate-spin align-[-2px]" />}
                {saveLabel[saveState]}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-bold text-gradient-brand">
              {passedCount}
              <span className="text-base font-medium text-muted-foreground"> / {total}</span>
            </p>
            <p className="text-xs text-muted-foreground">已通过</p>
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" /> 风险 {riskCount}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-warning" /> 待确认 {pendingCount}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full gradient-brand transition-all" style={{ width: `${progress}%` }} />
      </div>
      {riskCount > 0 && (
        <p className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertTriangle className="size-3.5" />
          存在 {riskCount} 项风险未处理，建议处理后再递交
        </p>
      )}
    </div>
  )
}

/* ---------------- 分组清单 ---------------- */
function GroupSection({
  group,
  libItems,
  statusMap,
  ownerMap,
  noteMap,
  onStatus,
  onOwner,
  onNote,
}: {
  group: (typeof checklistGroups)[number]
  libItems: Parameters<typeof libraryMatch>[1]
  statusMap: Record<string, CheckStatus>
  ownerMap: Record<string, string>
  noteMap: Record<string, string>
  onStatus: (key: string, s: CheckStatus) => void
  onOwner: (key: string, v: string) => void
  onNote: (key: string, v: string) => void
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-5 py-3">
        <span className="flex size-6 items-center justify-center rounded-md gradient-brand text-xs font-bold text-white">
          {group.id}
        </span>
        <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{group.items.length} 项</span>
      </div>
      <div className="divide-y divide-border">
        {group.items.map((item, i) => {
          const key = `${group.id}-${i}`
          return (
            <ChecklistItemRow
              key={key}
              itemKey={key}
              text={item}
              status={statusMap[key] ?? "pending"}
              owner={ownerMap[key] ?? ""}
              note={noteMap[key] ?? ""}
              lib={libraryMatch(item, libItems)}
              onStatus={onStatus}
              onOwner={onOwner}
              onNote={onNote}
            />
          )
        })}
      </div>
    </section>
  )
}

/** 单条检查项：状态三态按钮 + 责任人/备注输入 + 资料库联动徽标。 */
function ChecklistItemRow({
  itemKey,
  text,
  status,
  owner,
  note,
  lib,
  onStatus,
  onOwner,
  onNote,
}: {
  itemKey: string
  text: string
  status: CheckStatus
  owner: string
  note: string
  lib: ReturnType<typeof libraryMatch>
  onStatus: (key: string, s: CheckStatus) => void
  onOwner: (key: string, v: string) => void
  onNote: (key: string, v: string) => void
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center">
      <div className="flex flex-1 items-start gap-2">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${statusMeta[status].dot}`} />
        <div className="min-w-0">
          <span className="text-sm leading-relaxed text-foreground">{text}</span>
          {lib &&
            (lib.has ? (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-success">
                <CheckCircle2 className="size-3" />
                资料库已具备 · {lib.label}
              </span>
            ) : (
              <Link
                href="/library"
                className="ml-2 inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-destructive transition-opacity hover:opacity-80"
              >
                <X className="size-3" />
                资料库缺失 · 去补充
              </Link>
            ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          {(["pass", "risk", "pending"] as CheckStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => onStatus(itemKey, s)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                status === s ? statusMeta[s].badge : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {statusMeta[s].label}
            </button>
          ))}
        </div>
        <input
          value={owner}
          onChange={(e) => onOwner(itemKey, e.target.value)}
          placeholder="责任人"
          className="w-24 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <input
          value={note}
          onChange={(e) => onNote(itemKey, e.target.value)}
          placeholder="备注"
          className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>
    </div>
  )
}

/* ---------------- 导出区 ---------------- */

/** 前端模板 + 当前状态合成导出 groups；libraryHit 用现有 libraryMatch 结果。 */
function buildExportGroups(
  statusMap: Record<string, CheckStatus>,
  ownerMap: Record<string, string>,
  noteMap: Record<string, string>,
  libItems: Parameters<typeof libraryMatch>[1],
) {
  return checklistGroups.map((g) => ({
    id: g.id,
    title: g.title,
    items: g.items.map((text, i) => {
      const key = `${g.id}-${i}`
      const lib = libraryMatch(text, libItems)
      return {
        text,
        status: statusMap[key] ?? ("pending" as CheckStatus),
        owner: ownerMap[key] ?? "",
        note: noteMap[key] ?? "",
        libraryHit: lib ? `${lib.has ? "已具备" : "缺失"} · ${lib.label}` : null,
      }
    }),
  }))
}

function ExportPanel({
  cost,
  balance,
  projectId,
  statusMap,
  ownerMap,
  noteMap,
  libItems,
  onExported,
}: {
  cost: number
  balance: number
  projectId: string | null
  statusMap: Record<string, CheckStatus>
  ownerMap: Record<string, string>
  noteMap: Record<string, string>
  libItems: Parameters<typeof libraryMatch>[1]
  onExported: () => void
}) {
  const [open, setOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string; recharge?: boolean } | null>(null)

  async function doExportWord() {
    setOpen(false)
    setExporting(true)
    setMessage(null)
    setDownloadUrl(null) // 重新导出前清掉旧链接（旧预签名将失效）
    try {
      const { url } = await exportChecklist({
        ...(projectId ? { projectId } : {}),
        title: "投递前终极审核表",
        groups: buildExportGroups(statusMap, ownerMap, noteMap, libItems),
      })
      // 付费产物的交付以下方「下载 Word」链接为准；triggerDownload（隐藏 <a> 点击）不开新
      // 标签页、await 之后也不被弹窗拦截（预签名已带 attachment 下载名）。
      setDownloadUrl(url)
      triggerDownload(url)
      setMessage({ tone: "info", text: "已开始下载《投递前终极审核表.docx》，可在浏览器「下载」列表查看" })
      onExported() // 扣费成功，刷新余额
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null
      if (status === 402) setMessage({ tone: "error", text: "积分不足，无法导出", recharge: true })
      else setMessage({ tone: "error", text: "导出失败，请稍后重试" })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <CreditEstimate
        cost={cost}
        balance={balance}
        showSupportable={false}
        actionLabel="导出签字版审核表"
        onConfirm={() => setOpen((v) => !v)}
      />
      {message && (
        <p className={`mt-3 flex items-center justify-center gap-2 text-center text-xs font-medium ${message.tone === "error" ? "text-destructive" : "text-primary"}`}>
          {message.text}
          {message.recharge && (
            <Link href="/membership" className="font-semibold underline underline-offset-2">
              去充值
            </Link>
          )}
        </p>
      )}
      {downloadUrl && <ExportDownloadLink url={downloadUrl} />}
      {open && <ExportFormatButtons cost={cost} exporting={exporting} onWord={() => void doExportWord()} />}
      {exporting && !open && <p className="mt-3 text-center text-xs font-medium text-primary">正在生成签字版审核表（Word）…</p>}
      <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <HelpCircle className="size-3.5" />
        导出文件含签字栏与日期栏，可打印盖章存档
      </p>
    </div>
  )
}

/** 已生成产物的下载链接（弹窗被拦的兜底，付费产物不能只靠 window.open）。 */
function ExportDownloadLink({ url }: { url: string }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-1.5">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl gradient-brand px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
      >
        <FileDoc className="size-4" />
        下载 Word 审核表
      </a>
      <p className="text-[11px] text-muted-foreground">下载链接 300 秒内有效，过期请重新导出</p>
    </div>
  )
}

/** 导出格式按钮组：Word 可用，PDF / Excel 占位。 */
function ExportFormatButtons({ cost, exporting, onWord }: { cost: number; exporting: boolean; onWord: () => void }) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      <button
        onClick={onWord}
        disabled={exporting}
        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {exporting ? <Loader2 className="size-4 animate-spin text-primary" /> : <FileDoc className="size-4 text-primary" />}
        Word（{cost} 积分）
      </button>
      <button
        disabled
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-muted-foreground opacity-60"
      >
        <FileType2 className="size-4" />
        PDF · 即将上线
      </button>
      <button
        disabled
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-medium text-muted-foreground opacity-60"
      >
        <FileSpreadsheet className="size-4" />
        Excel · 即将上线
      </button>
    </div>
  )
}
