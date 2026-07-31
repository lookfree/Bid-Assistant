import { eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { bidProjects } from "../db/schema"

// 导出计费脏标记（2026-07-31 产品口径）：章节修改不收费，但**内容改过之后**的重新导出要收费。
// 此前是「首次收费、之后一律免费」，改完正文再导出拿新文件不花钱；现在按脏标记判定，
// 没改动就重复下载同一份仍免费——前端每点一次导出都会重渲，按次收费会让手滑重点一下就多扣 20 分。
//
// 用标记而非内容哈希：导出是每次点击的必经路径，哈希要把整本正文（几百 KB）读出来算，
// 与「导出路径不碰 result 列」的既有教训冲突。标记是 O(1) 且语义等价。

/** 内容发生变化：编辑回写提纲/正文、AI 改写单章、重跑提纲/正文步之后调用。幂等。 */
export async function markExportDirty(projectId: string): Promise<void> {
  await getDb().update(bidProjects).set({ exportDirty: true }).where(eq(bidProjects.id, projectId))
}

/** 导出成功收尾后调用：此后没改动的重复下载不再收费。幂等。 */
export async function clearExportDirty(projectId: string): Promise<void> {
  await getDb().update(bidProjects).set({ exportDirty: false }).where(eq(bidProjects.id, projectId))
}

/** 本次导出是否该收费。查不到项目一律按收费处理——漏收是钱的问题，误判免费是账目对不上的问题。 */
export async function shouldChargeExport(projectId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ dirty: bidProjects.exportDirty })
    .from(bidProjects)
    .where(eq(bidProjects.id, projectId))
  return row ? row.dirty : true
}
