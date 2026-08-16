/** 提纲沿用（2026-08-16 用户口径：提纲可编辑，改好的那版应能被同一份标书的下个项目沿用）。
 *
 *  为什么不能靠 agent 那边的提纲缓存来做：那份缓存的键是**招标文件字节哈希**，全局共享
 *  （同一份公开招标书任何用户传上来都命中同一条）。把某个用户编辑过的提纲写进去，等于
 *  把他的私人改动漏给所有人。所以沿用必须**按用户**取自他自己的历史项目，且**显式选择**。
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm"

import { getDb } from "../db/client"
import { bidProjects, projectSteps } from "../db/schema/bid-projects"
import { projectFiles } from "../db/schema/project-files"

export type ReuseCandidate = {
  projectId: string
  name: string
  chapterCount: number
  createdAt: string
  packageName: string | null
}

type FileIdent = { etag: string | null; size: number; filename: string }

const identKey = (f: FileIdent) => (f.etag ? `e:${f.etag}:${f.size}` : `n:${f.filename}:${f.size}`)

/** 项目的招标文件集合 → 内容指纹集合（顺序无关）。
 *  同一份标书的判定：优先 etag+size（MinIO 单段上传的 etag 就是内容 MD5，改一个字节就变），
 *  没有 etag（老数据/分段上传）退回 filename+size。
 *  **必须比全部文件**（spec320 多文件）：P1=[主文件,公告]、P2=[主文件,技术规范书] 只比首个
 *  会被判成同一份，而 merge_parsed 按文件顺序整体偏移 sec-N——沿用来的 clause_ids 会落到
 *  另一份文档的条款上，该章的招标要求整段拿错（评审 2026-08-16 F4）。 */
async function identsOf(keys: string[]): Promise<Set<string> | null> {
  if (!keys.length) return null
  const rows = await getDb()
    .select({ key: projectFiles.key, etag: projectFiles.etag, size: projectFiles.size, filename: projectFiles.filename })
    .from(projectFiles)
    .where(inArray(projectFiles.key, keys))
  if (rows.length !== keys.length) return null // 有文件查不到指纹 → 宁可不给沿用
  return new Set(rows.map(identKey))
}

const sameIdents = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))

const filesOf = (p: { tenderFileKey: string | null; tenderFileKeys: string[] | null }) =>
  (p.tenderFileKeys?.length ? p.tenderFileKeys : p.tenderFileKey ? [p.tenderFileKey] : []).filter(Boolean)

/** 本项目可沿用的历史提纲候选：同一用户、**同一份招标文件集合**、**同一包件**、提纲步已完成。
 *
 *  包件必须相同（评审 2026-08-16 F1）：多包件下同一份标书的兄弟项目恰恰就是「投另一个包＝
 *  clone 另建项目」（spec324），A 包的提纲套到 B 包项目上，B 包独有的必备构成项/表单整章缺失
 *  ——形式审查即废标。宁可不给沿用。 */
export async function outlineReuseCandidates(
  projectId: string,
  userId: string,
  limit = 5,
): Promise<ReuseCandidate[]> {
  const db = getDb()
  const [self] = await db
    .select({
      tenderFileKey: bidProjects.tenderFileKey,
      tenderFileKeys: bidProjects.tenderFileKeys,
      selectedPackage: bidProjects.selectedPackage,
    })
    .from(bidProjects)
    .where(and(eq(bidProjects.id, projectId), eq(bidProjects.userId, userId)))
  if (!self) return []
  const selfIdents = await identsOf(filesOf(self))
  if (!selfIdents) return []
  const selfPkg = self.selectedPackage?.id ?? null
  // 章数走 SQL 侧 jsonb_array_length，整份 outline JSONB 绝不拉回内存（slim 铁律：
  // 项目状态查询实测 28ms vs 2788ms 的差距就出在选不选 result 列，评审 2026-08-16 F5）。
  const rows = await db
    .select({
      id: bidProjects.id,
      name: bidProjects.name,
      createdAt: bidProjects.createdAt,
      tenderFileKey: bidProjects.tenderFileKey,
      tenderFileKeys: bidProjects.tenderFileKeys,
      selectedPackage: bidProjects.selectedPackage,
      chapterCount: sql<number>`jsonb_array_length(${projectSteps.result} -> 'chapters')`,
    })
    .from(bidProjects)
    .innerJoin(
      projectSteps,
      and(
        eq(projectSteps.projectId, bidProjects.id),
        eq(projectSteps.step, "outline"),
        eq(projectSteps.status, "done"),
        sql`jsonb_typeof(${projectSteps.result} -> 'chapters') = 'array'`,
        sql`jsonb_array_length(${projectSteps.result} -> 'chapters') > 0`,
      ),
    )
    .where(and(eq(bidProjects.userId, userId), ne(bidProjects.id, projectId)))
    .orderBy(desc(projectSteps.createdAt))
  const out: ReuseCandidate[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.id)) continue // 同项目多条 done 提纲：只取最新那条（上面已按时间倒序）
    if ((r.selectedPackage?.id ?? null) !== selfPkg) continue
    const idents = await identsOf(filesOf(r))
    if (!idents || !sameIdents(idents, selfIdents)) continue
    seen.add(r.id)
    out.push({
      projectId: r.id,
      name: r.name ?? "未命名项目",
      chapterCount: Number(r.chapterCount) || 0,
      createdAt: r.createdAt.toISOString(),
      packageName: r.selectedPackage?.name ?? null,
    })
    if (out.length >= limit) break
  }
  return out
}

/** 取某个候选项目的提纲原文（snake 原样，直接作为 state_overrides.outline 下发）。
 *  必须重新校验归属/同文件/同包件——路由拿到的 id 来自请求体，不能只信前端给的候选列表。
 *  **取的必须是候选里数过章数的那一行**（评审 F3：列出的行与取用的行不是同一条时，
 *  卡片上的章数张冠李戴，取到空 chapters 还会以 0 积分放行一次完整生成）。 */
export async function reusableOutline(
  fromProjectId: string,
  projectId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const ok = (await outlineReuseCandidates(projectId, userId, 100)).some((c) => c.projectId === fromProjectId)
  if (!ok) return null
  const [row] = await getDb()
    .select({ result: projectSteps.result })
    .from(projectSteps)
    .where(
      and(
        eq(projectSteps.projectId, fromProjectId),
        eq(projectSteps.step, "outline"),
        eq(projectSteps.status, "done"),
        sql`jsonb_typeof(${projectSteps.result} -> 'chapters') = 'array'`,
        sql`jsonb_array_length(${projectSteps.result} -> 'chapters') > 0`,
      ),
    )
    .orderBy(desc(projectSteps.createdAt))
    .limit(1)
  const outline = row?.result as Record<string, unknown> | null
  const chapters = (outline as { chapters?: unknown[] } | null)?.chapters
  return Array.isArray(chapters) && chapters.length ? outline : null
}
