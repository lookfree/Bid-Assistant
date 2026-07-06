import { closeDb } from "../db/client"
import { seedConfigs } from "../services/config"
import { seedPlans } from "../config/plans-seed"

// 基础业务种子（新环境安装/每次部署自动跑）：billing_configs（credit_cost.* 等）+ plans 会员套餐。
//   用法：bun run db:seed（deploy.sh 在 db:migrate 之后调用）
// 幂等：seedConfigs=onConflictDoNothing（键存在跳过）；seedPlans=按 (code,billing_cycle) 存在即跳过。
//   → 绝不覆盖运营后台已改过的价格/口径，重复跑安全。
// 不含运营账号/superadmin（需口令、敏感）：那部分仍走独立 admin:bootstrap。
async function main() {
  await seedConfigs()
  const { inserted } = await seedPlans()
  console.log(`✓ db:seed 完成：billing_configs 已就绪；plans 新插入 ${inserted} 行（已存在的档位跳过，不覆盖运营改价）。`)
  await closeDb()
}

main().catch((e) => {
  console.error("db:seed 失败：", e instanceof Error ? e.message : e)
  process.exit(1)
})
