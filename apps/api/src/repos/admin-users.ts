import { eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { adminUsers, type AdminUser, type AdminRole, type AdminStatus } from "../db/schema"

// admin 用户仓储（spec309，独立于 C 端 users）。

export async function getAdminById(id: string): Promise<AdminUser | null> {
  const [row] = await getDb().select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1)
  return row ?? null
}

export async function findAdminByUsername(username: string): Promise<AdminUser | null> {
  const [row] = await getDb().select().from(adminUsers).where(eq(adminUsers.username, username)).limit(1)
  return row ?? null
}

export async function createAdmin(input: {
  username: string
  passwordHash: string
  role: AdminRole
}): Promise<AdminUser> {
  const [row] = await getDb().insert(adminUsers).values(input).returning()
  return row!
}

export async function setAdminStatus(id: string, status: AdminStatus): Promise<void> {
  await getDb().update(adminUsers).set({ status }).where(eq(adminUsers.id, id))
}
