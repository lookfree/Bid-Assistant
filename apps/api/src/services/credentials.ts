import { and, desc, eq, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles } from "../db/schema"

// 附录渲染仅认图片扩展（docx 无法内嵌 pdf，见 spec325 Global Constraints）
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg"])

function extOf(key: string): string {
  return key.split(".").pop()?.toLowerCase() ?? ""
}

// images 从 string[] 改对象数组（2026-08-09 附录系统章节）：agent 拿 fileId 拼占位图
// data-file-id（编辑器/导出各自解析取字节），key/name 供展示与后续渲染使用。
// ocrText（2026-08-09 定向注入 Task 2）：附件的前置 OCR 识别文字透传给 agent 拼占位图 alt；
// 附件未回填（后台 OCR 尚未跑完/非图片）则该键缺省，agent 侧宽容处理（退化成纯标题 alt）。
export type CredentialInput = { title: string; images: { fileId: string; key: string; name: string; ocrText?: string }[] }

// content 步 run_input.credentials 下发（2026-08-09 起，原 spec325 的 export 步下发已退役）：
// 取该用户「资质」类资料库条目挂的图片附件，交 agent 在正文收尾时确定性构建「资格证明文件」
// 系统章节（占位图，无字节）。GET export-preview 复用本函数做资质预告，取 images.length 计数。
// 无资质条目/条目无图片附件 → 返回 undefined（调用方不设该键，行为与无资质时一致）。
export async function credentialsRunInput(userId: string): Promise<CredentialInput[] | undefined> {
  const items = await getDb()
    .select({ title: libraryItems.title, attachments: libraryItems.attachments })
    .from(libraryItems)
    .where(and(eq(libraryItems.userId, userId), eq(libraryItems.category, "qualification")))

  const fileIds = items.flatMap((i) => (i.attachments ?? []).map((a) => a.fileId))
  if (fileIds.length === 0) return undefined

  // 属主二次校验：只认本人 project_files 行，防越权引用他人 fileId
  const files = await getDb()
    .select({ id: projectFiles.id, key: projectFiles.key })
    .from(projectFiles)
    .where(and(inArray(projectFiles.id, fileIds), eq(projectFiles.userId, userId)))
  const keyById = new Map(files.map((f) => [f.id, f.key]))

  const credentials = items
    .map((item) => ({
      title: item.title,
      images: (item.attachments ?? [])
        .map((a) => {
          const key = keyById.get(a.fileId)
          return key && IMAGE_EXTS.has(extOf(key))
            ? { fileId: a.fileId, key, name: a.name, ...(a.ocrText ? { ocrText: a.ocrText } : {}) }
            : null
        })
        .filter((x): x is { fileId: string; key: string; name: string; ocrText?: string } => x !== null),
    }))
    .filter((c) => c.images.length > 0)

  return credentials.length > 0 ? credentials : undefined
}

export type LibraryRefItem = { title: string; meta?: string; fields?: { label: string; value: string }[]; body?: string }

const LIBRARY_REF_LIMIT = 20

// content 步 run_input.library_refs（2026-08-09 定向注入 Task 2）：人员/业绩类资料库条目直发给
// agent，按章关键词命中后确定性拼进简报——不再赌 RAG 召回率。每类按更新时间倒序截前 20 条
// （预算见 Global Constraints），两类都空则不下发该键，agent 侧按键缺失判断「库空」。
export async function libraryRefsRunInput(
  userId: string,
): Promise<{ library_refs?: { personnel: LibraryRefItem[]; performance: LibraryRefItem[] } }> {
  const [personnel, performance] = await Promise.all([
    fetchLibraryRefs(userId, "personnel"),
    fetchLibraryRefs(userId, "performance"),
  ])
  if (personnel.length === 0 && performance.length === 0) return {}
  return { library_refs: { personnel, performance } }
}

async function fetchLibraryRefs(userId: string, category: "personnel" | "performance"): Promise<LibraryRefItem[]> {
  const rows = await getDb()
    .select({ title: libraryItems.title, meta: libraryItems.meta, fields: libraryItems.fields, body: libraryItems.body })
    .from(libraryItems)
    .where(and(eq(libraryItems.userId, userId), eq(libraryItems.category, category)))
    .orderBy(desc(libraryItems.updatedAt))
    .limit(LIBRARY_REF_LIMIT)

  return rows.map((r) => ({
    title: r.title,
    ...(r.meta ? { meta: r.meta } : {}),
    ...(r.fields && r.fields.length > 0 ? { fields: r.fields } : {}),
    ...(r.body ? { body: r.body } : {}),
  }))
}
