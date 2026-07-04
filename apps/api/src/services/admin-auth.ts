import { randomBytes, createHash } from "node:crypto"
import { createAdminSession, findValidAdminSession, revokeAdminSession } from "../repos/admin-sessions"
import { findAdminByUsername, getAdminById } from "../repos/admin-users"
import type { AdminUser } from "../db/schema"

// admin 登录/会话（spec309）：密码 Bun.password 哈希（非 native bcrypt）；token 不透明随机串，DB 只存 sha256。
const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // admin 会话 8 小时（权限大，短时效）

export function hashAdminToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

// 密码哈希（建账号用；种子 / spec310 创建 admin 复用）
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain) // 默认 argon2id，非 native bcrypt（§2.2 纪律③）
}

export async function loginAdmin(username: string, password: string): Promise<{ token: string; admin: AdminUser } | null> {
  const admin = await findAdminByUsername(username)
  if (!admin || admin.status !== "active") return null
  const ok = await Bun.password.verify(password, admin.passwordHash)
  if (!ok) return null
  const token = randomBytes(32).toString("hex")
  await createAdminSession({ adminId: admin.id, tokenHash: hashAdminToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
  return { token, admin }
}

// 解析 admin token —— 只查 admin_sessions，绝不查 C 端 sessions。
export async function resolveAdminFromToken(token: string): Promise<AdminUser | null> {
  const session = await findValidAdminSession(hashAdminToken(token))
  if (!session) return null
  const admin = await getAdminById(session.adminId)
  if (!admin || admin.status !== "active") return null
  return admin
}

export async function logoutAdmin(token: string): Promise<void> {
  const session = await findValidAdminSession(hashAdminToken(token))
  if (session) await revokeAdminSession(session.id)
}
