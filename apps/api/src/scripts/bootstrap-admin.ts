import { seedAdminRoles, seedSuperadmin } from "../config/admin-seed"
import { closeDb } from "../db/client"

// 运营后台开天辟地引导（spec310 / spec309 followup A1）：一次性建角色权限集 + 首个 superadmin。
// 幂等：重复跑不重复建（onConflictDoNothing）。生产必须提供 ADMIN_BOOTSTRAP_USERNAME/PASSWORD（占位口令会被拒）。
//   用法：bun run admin:bootstrap
async function main() {
  await seedAdminRoles()
  const username = await seedSuperadmin({
    ADMIN_BOOTSTRAP_USERNAME: process.env.ADMIN_BOOTSTRAP_USERNAME,
    ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD,
  })
  console.log(`✓ admin bootstrap 完成：角色权限集就绪，首个 superadmin='${username}'（已存在则跳过）`)
  await closeDb()
}

main().catch((e) => {
  console.error("admin bootstrap 失败：", e instanceof Error ? e.message : e)
  process.exit(1)
})
