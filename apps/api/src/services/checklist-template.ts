import { and, desc, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectChecklists, projectSteps, type ChecklistGroup } from "../db/schema"
import * as client from "./agent-client"

// 定制审核表模板（spec333）：读标结论 → 模型生成分组核对项 → 存 project_checklists.template。
// 计费归属读标步（本模块 best-effort，不预扣不结算）；agent 依旧 money-blind。
// 铁律：生成失败/无读标结果/模型未配置都返回 null（前端回落默认 36），绝不抛错影响读标结果交付。

export type TemplateDeps = {
  getAgentModel: typeof client.getAgentModel
  generateChecklist: typeof client.generateChecklist
}

/** 取项目最近一次成功读标结果（project_steps step=read done）；无则 null。 */
async function latestReadResult(projectId: string): Promise<Record<string, unknown> | null> {
  const [row] = await getDb()
    .select({ result: projectSteps.result })
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "read"), eq(projectSteps.status, "done")))
    .orderBy(desc(projectSteps.createdAt))
    .limit(1)
  return (row?.result as Record<string, unknown> | null) ?? null
}

/** 取 (userId, projectId) 已存的定制模板；无行/无模板 → null。 */
async function existingTemplate(userId: string, projectId: string): Promise<ChecklistGroup[] | null> {
  const [row] = await getDb()
    .select({ template: projectChecklists.template })
    .from(projectChecklists)
    .where(and(eq(projectChecklists.userId, userId), eq(projectChecklists.projectId, projectId)))
  return row?.template ?? null
}

/**
 * 定制审核表：已存直返；否则读读标结果 → 解析后台模型 → agent 生成 → upsert 存 template。
 * best-effort——任一前置不成立（无读标结果/模型未配置/生成失败/空表）返回 null，前端回落默认 36。
 * 全程 try/catch 吞错：读标步已收费，审核表生成绝不二次扣费、也绝不因失败反噬读标结果交付。
 */
export async function ensureChecklistTemplate(
  { userId, projectId }: { userId: string; projectId: string },
  deps: Partial<TemplateDeps> = {},
): Promise<ChecklistGroup[] | null> {
  const getModel = deps.getAgentModel ?? client.getAgentModel
  const generate = deps.generateChecklist ?? client.generateChecklist
  try {
    const existing = await existingTemplate(userId, projectId)
    if (existing?.length) return existing // 已生成过：直返，绝不重复调用模型
    const read = await latestReadResult(projectId)
    if (!read) return null // 无读标结果（独立审查未传招标文件）→ 默认 36
    const model = await getModel()
    if (!model) return null // 模型未配置：best-effort 不报错、不占步位，回落默认 36
    const { groups } = await generate(read, model)
    if (!groups?.length) return null
    // upsert：只写 template（items 由 PUT 单独维护，互不覆盖）；(user,project) 唯一约束命中。
    await getDb()
      .insert(projectChecklists)
      .values({ userId, projectId, template: groups })
      .onConflictDoUpdate({
        target: [projectChecklists.userId, projectChecklists.projectId],
        set: { template: groups, updatedAt: new Date() },
      })
    return groups
  } catch (e) {
    console.error(`[checklist] 定制审核表生成失败（回落默认 36）project=${projectId}`, e)
    return null
  }
}
