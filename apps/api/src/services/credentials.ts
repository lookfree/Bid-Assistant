import { and, eq, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles } from "../db/schema"

// export 步渲染附录仅认图片扩展（docx 无法内嵌 pdf，见 spec325 Global Constraints）
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg"])

function extOf(key: string): string {
  return key.split(".").pop()?.toLowerCase() ?? ""
}

export type CredentialInput = { title: string; images: string[] }

// export 步 run_input.credentials 下发（spec325）：取该用户「资质」类资料库条目挂的图片附件 key，
// 交 agent 导出时追加「资格证明文件」附录（agent 自行用 key 取字节，展示名取 key basename）。
// 无资质条目/条目无图片附件 → 返回 undefined（调用方不设该键，导出行为与今天一致）。
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
        .map((a) => keyById.get(a.fileId))
        .filter((k): k is string => !!k && IMAGE_EXTS.has(extOf(k))),
    }))
    .filter((c) => c.images.length > 0)

  return credentials.length > 0 ? credentials : undefined
}
