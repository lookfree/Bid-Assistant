import { adminTokenStore } from "./admin-token-store"

// admin API 客户端（spec309）：base /admin-api，Bearer admin token（与 C 端隔离）。
const baseUrl = process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/admin-api"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  const token = adminTokenStore.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`admin api ${res.status}`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export type AdminMe = { id: string; username: string; role: string; status: string }

export const adminApi = {
  login: (username: string, password: string) =>
    req<{ token: string; admin: { id: string; username: string; role: string } }>("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => req<{ admin: AdminMe }>("/me"),
  logout: () => req<void>("/logout", { method: "POST" }),
}
