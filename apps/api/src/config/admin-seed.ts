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

const DEV_PLACEHOLDER_PASSWORD = "ChangeMe-dev-only"

// 首个 superadmin（账号/口令从 env 注入；缺省用开发占位）。
// 生产环境拒绝用占位口令建全权账号——否则 well-known 凭据可被任何知道本仓库的人接管整个后台。
export async function seedSuperadmin(env: { ADMIN_BOOTSTRAP_USERNAME?: string; ADMIN_BOOTSTRAP_PASSWORD?: string }): Promise<void> {
  const username = env.ADMIN_BOOTSTRAP_USERNAME ?? "admin"
  const password = env.ADMIN_BOOTSTRAP_PASSWORD ?? DEV_PLACEHOLDER_PASSWORD
  if (process.env.NODE_ENV === "production" && password === DEV_PLACEHOLDER_PASSWORD) {
    throw new Error("生产环境必须通过 ADMIN_BOOTSTRAP_PASSWORD 提供非占位口令")
  }
  await getDb()
    .insert(adminUsers)
    .values({ username, passwordHash: await hashPassword(password), role: "superadmin" })
    .onConflictDoNothing({ target: adminUsers.username })
}
