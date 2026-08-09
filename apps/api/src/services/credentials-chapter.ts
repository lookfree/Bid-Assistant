import { and, desc, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectSteps } from "../db/schema"
import type { CredentialInput } from "./credentials"

// 「资格证明文件」附录 → 生成期系统章节（2026-08-09 附录系统章节设计,Plan A①）。App 侧的
// 确定性实现——与 agent 侧 services/agent/.../nodes/credentials_chapter.py 逐字同形（两端各自
// 持有一份,不共用代码）：字面量一改就要同步改另一处,否则编辑器/审查看到的章节两端会打架。

export const SYS_CREDS_ID = "sys-creds"

// 系统章字面量——与计划 Global Constraints、agent 侧 SYS_CREDS_CHAPTER 逐字同形。items 留空
// 数组：这一章不走提纲的二级节结构，内容全在 content 步 result[SYS_CREDS_ID] 这段 HTML 里。
export const SYS_CREDS_CHAPTER = {
  id: SYS_CREDS_ID,
  no: "附录",
  title: "资格证明文件",
  group: "business",
  system: true,
  sourced: false,
  items: [] as unknown[],
}

/** HTML 转义,文本节点与属性值通用——条目标题来自用户在资料库里手写,含 <>&" 会破坏标签结构
 *  或提前把 alt 属性闭合掉。思路照抄 agent 侧 _esc / web 侧 lib/image-insert.ts 的 escAttrValue。 */
function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const OCR_ALT_CHARS = 120

/** 占位图 alt：`标题|ocrText 截前 120 字`（无 ocrText 则纯标题）,整串统一转义一次——与 agent 侧
 *  credentials_chapter.py `_image_alt` 逐字节同形（终审 I-4：此前只有章内证照 post-pass 的
 *  占位图带 OCR 摘要,附录章占位图仍是纯标题,两处占位图 alt 语义不该不一致）。传入 rawTitle
 *  必须是未转义的原始标题,与 ocrText 拼接后一并转义,避免先转义再拼接导致的二次转义。
 *
 *  截断必须按**码点**（不是 sliceAtCodePoint 的码元语义,那个只保证不切穿代理对,计数仍按
 *  UTF-16 code unit）——Python 侧 `ocr[:120]` 按码点索引。emoji 若恰好落在第 120 个码点上,
 *  两端用不同语义截会产出不同字符串;若用裸 code-unit slice 更会切穿代理对,产出孤立代理,
 *  该串经 JSON 传给 agent 服务后 httpx 编码请求体抛 UnicodeEncodeError,拖垮同请求里的
 *  全部模型调用（2026-08-09 review campaign 复现）。`Array.from` 按码点遍历字符串,
 *  与 Python 索引语义一致,两端 alt 逐字相同（Plan A 双端同形铁律）。 */
function imageAlt(rawTitle: string, ocrText: string | undefined): string {
  const ocr = (ocrText ?? "").trim()
  const truncated = Array.from(ocr).slice(0, OCR_ALT_CHARS).join("")
  const label = ocr ? `${rawTitle}|${truncated}` : rawTitle
  return esc(label)
}

/** 资格证明文件章 HTML——每个条目一个 <h3>标题</h3>,逐图一个占位 <img>（三属性:
 *  data-file-id/data-object-key/alt,**无 src 无字节**),包在 <p> 里,与既有章节 HTML 风格一致。
 *  alt 带 OCR 摘要（终审 I-4,与章内证照 post-pass 同形）。空数组（资料库无资质条目）返回
 *  空串,调用方据此判断是否需要构建/追加系统章。 */
export function buildCredentialsChapterHtml(credentials: CredentialInput[]): string {
  if (!credentials.length) return ""
  const parts: string[] = []
  for (const entry of credentials) {
    parts.push(`<h3>${esc(entry.title)}</h3>`)
    for (const img of entry.images) {
      const alt = imageAlt(entry.title, img.ocrText)
      parts.push(`<p><img data-file-id="${esc(img.fileId)}" data-object-key="${esc(img.key)}" alt="${alt}" /></p>`)
    }
  }
  return parts.join("\n")
}

/** outline 是否已含系统章（去重判据,与 agent 侧 _has_sys_creds 同形）。 */
function hasSysCredsChapter(outline: unknown): boolean {
  const chapters = (outline as { chapters?: unknown[] } | null)?.chapters
  return Array.isArray(chapters) && chapters.some((c) => (c as { id?: unknown })?.id === SYS_CREDS_ID)
}

/** content 步收尾钩子（也供刷新端点复用）：contentResult 里带 sys-creds 键时,把系统章追加进
 *  库里 outline result——编辑器/审查/导出页都读这份库存,不追加就只有 agent 图内 state 知道这
 *  章存在,下次刷新页面就看不到。
 *
 *  幂等（评审约束,见计划 Global Constraints「重建语义」）：outline 已含 sys-creds 是常态——
 *  agent 侧每次 content 收尾都会经 state_overrides 回灌库里 outline 再原样带出,本钩子只需
 *  「没有才追加」,不必感知第几次生成、也不重复堆章节。事务内 FOR UPDATE 锁行做 check-then-update：
 *  与本仓既有的单章改写（rewrite 端点）同一并发手法,防止两次收尾并发追加出两条 sys-creds。
 *
 *  contentResult 不含 sys-creds 键（用户资料库无资质条目）→ 不动；outline 步尚未产出（理论不
 *  可达,content 依赖 outline 先完成）→ 不动，留给下一次收尾/刷新补。 */
export async function syncCredentialsOutline(projectId: string, contentResult: unknown): Promise<void> {
  if (!contentResult || typeof contentResult !== "object" || !(SYS_CREDS_ID in (contentResult as Record<string, unknown>))) {
    return
  }
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: projectSteps.id, result: projectSteps.result })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "outline"), eq(projectSteps.status, "done")))
      .orderBy(desc(projectSteps.createdAt))
      .limit(1)
      .for("update")
    if (!row || hasSysCredsChapter(row.result)) return
    const outline = (row.result ?? { chapters: [] }) as { chapters?: unknown[] }
    const newOutline = { ...outline, chapters: [...(outline.chapters ?? []), { ...SYS_CREDS_CHAPTER, items: [] }] }
    await tx.update(projectSteps).set({ result: newOutline }).where(eq(projectSteps.id, row.id))
  })
}
