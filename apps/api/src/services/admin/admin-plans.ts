import { eq } from "drizzle-orm"
import { getDb } from "../../db/client"
import { plans } from "../../db/schema"
import { writeAudit } from "../audit"

// 套餐服务（spec310）：plans CRUD + 审计。billing_configs 读写在 route 层直接消费 spec301 getConfig/setConfig。
export async function listPlans() {
  return getDb().select().from(plans).orderBy(plans.createdAt)
}

export async function createPlan(
  input: {
    name: string
    code?: string
    priceCents?: number
    currency?: string
    billingCycle: string
    grantCreditsPerCycle?: number
    features?: Record<string, unknown>
    limits?: Record<string, unknown>
  },
  opts: { operator: string },
) {
  const [p] = await getDb().insert(plans).values(input).returning()
  await writeAudit({ operator: opts.operator, action: "plan.write", target: `plan:${p!.id}`, before: null, after: p })
  return p!
}

export async function updatePlan(
  id: string,
  patch: Partial<{ priceCents: number; grantCreditsPerCycle: number; status: string; features: Record<string, unknown>; limits: Record<string, unknown> }>,
  opts: { operator: string },
) {
  const db = getDb()
  const [before] = await db.select().from(plans).where(eq(plans.id, id))
  if (!before) throw new Error("套餐不存在")
  // 改价/改权益时 version 自增，避免历史订阅口径错乱（快照在下单时锁定，spec305）
  const bump = patch.priceCents !== undefined || patch.grantCreditsPerCycle !== undefined ? 1 : 0
  const [after] = await db
    .update(plans)
    .set({ ...patch, version: (before.version ?? 1) + bump })
    .where(eq(plans.id, id))
    .returning()
  await writeAudit({ operator: opts.operator, action: "plan.write", target: `plan:${id}`, before, after })
  return after!
}
