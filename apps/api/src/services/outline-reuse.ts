/** 提纲沿用（2026-08-16 用户口径：提纲可编辑，改好的那版应能被同一份标书的下个项目沿用）。
 *
 *  为什么不能靠 agent 那边的提纲缓存来做：那份缓存的键是**招标文件字节哈希**，全局共享
 *  （同一份公开招标书任何用户传上来都命中同一条）。把某个用户编辑过的提纲写进去，等于
 *  把他的私人改动漏给所有人。所以沿用必须**按用户**取自他自己的历史项目，且**显式选择**。
 */
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm"

import { getDb } from "../db/client"
import { bidProjects, projectSteps } from "../db/schema/bid-projects"
import { projectFiles } from "../db/schema/project-files"

export type ReuseCandidate = {
  projectId: string
  name: string
  chapterCount: number
  createdAt: string
}

/** 同一份招标文件的判定：优先 etag+size（MinIO 对单段上传就是内容 MD5，改一个字节就变），
 *  没有 etag（老数据/分段上传）退回 filename+size。两者都不匹配就不算同一份——
 *  沿用错标书的提纲比不给沿用糟得多。 */
async function sameTenderKeys(userId: string, tenderKey: string): Promise<string[]> {
  const db = getDb()
  const [self] = await db
    .select({ etag: projectFiles.etag, size: projectFiles.size, filename: projectFiles.filename })
    .from(projectFiles)
    .where(eq(projectFiles.key, tenderKey))
  if (!self) return [tenderKey]
  const rows = await db
    .select({ key: projectFiles.key, etag: projectFiles.etag, size: projectFiles.size, filename: projectFiles.filename })
    .from(projectFiles)
    .where(eq(projectFiles.userId, userId))
  return rows
    .filter((f) =>
      self.etag && f.etag ? f.etag === self.etag && f.size === self.size : f.filename === self.filename && f.size === self.size,
    )
    .map((f) => f.key)
}

/** 本项目可沿用的历史提纲候选（同一用户、同一份招标文件、该项目 outline 步已完成）。
 *  按时间倒序，最多 limit 条。查不到返回空数组——前端据此决定要不要显示沿用入口。 */
export async function outlineReuseCandidates(
  projectId: string,
  userId: string,
  tenderKey: string,
  limit = 5,
): Promise<ReuseCandidate[]> {
  const keys = await sameTenderKeys(userId, tenderKey)
  if (!keys.length) return []
  const db = getDb()
  const projects = await db
    .select({ id: bidProjects.id, name: bidProjects.name, createdAt: bidProjects.createdAt })
    .from(bidProjects)
    .where(
      and(
        eq(bidProjects.userId, userId),
        ne(bidProjects.id, projectId),
        inArray(bidProjects.tenderFileKey, keys),
        isNotNull(bidProjects.name),
      ),
    )
    .orderBy(desc(bidProjects.createdAt))
  if (!projects.length) return []
  const steps = await db
    .select({ projectId: projectSteps.projectId, result: projectSteps.result })
    .from(projectSteps)
    .where(
      and(
        eq(projectSteps.step, "outline"),
        eq(projectSteps.status, "done"),
        inArray(
          projectSteps.projectId,
          projects.map((p) => p.id),
        ),
      ),
    )
  const byProject = new Map(steps.map((s) => [s.projectId, s.result]))
  const out: ReuseCandidate[] = []
  for (const p of projects) {
    const chapters = (byProject.get(p.id) as { chapters?: unknown[] } | undefined)?.chapters
    if (!Array.isArray(chapters) || !chapters.length) continue
    out.push({
      projectId: p.id,
      name: p.name ?? "未命名项目",
      chapterCount: chapters.length,
      createdAt: p.createdAt.toISOString(),
    })
    if (out.length >= limit) break
  }
  return out
}

/** 取某个候选项目的提纲原文（snake 原样，直接作为 state_overrides.outline 下发）。
 *  必须重新校验归属与同文件——路由拿到的 projectId 来自请求体，不能只信前端给的候选列表。 */
export async function reusableOutline(
  fromProjectId: string,
  projectId: string,
  userId: string,
  tenderKey: string,
): Promise<Record<string, unknown> | null> {
  const ok = (await outlineReuseCandidates(projectId, userId, tenderKey, 100)).some((c) => c.projectId === fromProjectId)
  if (!ok) return null
  const [row] = await getDb()
    .select({ result: projectSteps.result })
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, fromProjectId), eq(projectSteps.step, "outline"), eq(projectSteps.status, "done")))
    .orderBy(desc(projectSteps.createdAt))
  const outline = row?.result as Record<string, unknown> | null
  return outline && Array.isArray((outline as { chapters?: unknown[] }).chapters) ? outline : null
}
