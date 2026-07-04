import { getDb } from "../db/client"
import { adminRoles, adminUsers, ADMIN_ROLES } from "../db/schema"
import { ROLE_PERMISSIONS } from "../services/rbac"
import { hashPassword } from "../services/admin-auth"

// admin 种子（spec309）：角色权限集 + 首个 superadmin（env 注入，幂等）。

// 种子角色权限集（与代码内 ROLE_PERMISSIONS 一致；spec310 后台可在此表覆盖/可视化）。
export async function seedAdminRoles(): Promise<void> {
  const db = getDb()
  for (const role of ADMIN_ROLES) {
    await db.insert(adminRoles).values({ role, permissions: ROLE_PERMISSIONS[role] }).onConflictDoNothing({ target: adminRoles.role })
  }
}

// 首个 superadmin（账号/口令从 env 注入；缺省用开发占位，生产必须改）。
export async function seedSuperadmin(env: { ADMIN_BOOTSTRAP_USERNAME?: string; ADMIN_BOOTSTRAP_PASSWORD?: string }): Promise<void> {
  const username = env.ADMIN_BOOTSTRAP_USERNAME ?? "admin"
  const password = env.ADMIN_BOOTSTRAP_PASSWORD ?? "ChangeMe-dev-only"
  await getDb()
    .insert(adminUsers)
    .values({ username, passwordHash: await hashPassword(password), role: "superadmin" })
    .onConflictDoNothing({ target: adminUsers.username })
}
