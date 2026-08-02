import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { adminRoutes } from "../src/routes/admin"
import { getDb, closeDb } from "../src/db/client"
import { adminUsers, billingConfigs } from "../src/db/schema"
import { makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"
import { resetRbacCache, RBAC_CONFIG_KEY } from "../src/services/admin-rbac"
import { ROLE_PERMISSIONS } from "../src/services/rbac"

// 可编辑 RBAC（2026-08-02）：角色→权限从硬编码升级为后台可编辑；读接口按矩阵接线
// （QA：财务能看用户信息、纠偏页无角色控制）。连真库。
setDefaultTimeout(TEST_TIMEOUT_MS)

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeAdmins: string[] = []
const regA = (id: string) => madeAdmins.push(id)

// 恢复出厂矩阵：删配置行 + 清缓存（其余套件依赖默认矩阵,绝不留污染）
const restoreDefaults = async () => {
  await getDb().delete(billingConfigs).where(eq(billingConfigs.key, RBAC_CONFIG_KEY))
  resetRbacCache()
}

afterAll(async () => {
  await restoreDefaults()
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

describe("读接口按矩阵接线", () => {
  it("财务：用户列表/详情 403（QA 上报）；客服 user.read → 200", async () => {
    await restoreDefaults()
    const fin = await makeAdminSession("finance", regA)
    const sup = await makeAdminSession("support", regA)
    expect((await app.request("http://x/admin-api/users?page=1&pageSize=10", { headers: fin.headers })).status).toBe(403)
    expect((await app.request("http://x/admin-api/users?page=1&pageSize=10", { headers: sup.headers })).status).toBe(200)
  })

  it("纠偏样本页：category.read（默认 ops 有、财务/客服无）", async () => {
    const fin = await makeAdminSession("finance", regA)
    const ops = await makeAdminSession("ops", regA)
    expect((await app.request("http://x/admin-api/bid-categories/corrections?page=1&pageSize=10", { headers: fin.headers })).status).toBe(403)
    expect((await app.request("http://x/admin-api/bid-categories/corrections?page=1&pageSize=10", { headers: ops.headers })).status).toBe(200)
  })

  it("/me 返回该角色的生效权限集（前端菜单/按钮的唯一数据源）", async () => {
    const fin = await makeAdminSession("finance", regA)
    const body = (await (await app.request("http://x/admin-api/me", { headers: fin.headers })).json()) as {
      admin: { permissions: string[] }
    }
    expect(body.admin.permissions.sort()).toEqual([...ROLE_PERMISSIONS.finance].sort())
  })
})

describe("PUT /rbac：矩阵可编辑", () => {
  it("superadmin 给财务加 user.read → 保存即生效（缓存被重置）；恢复默认后又拦回", async () => {
    const root = await makeAdminSession("superadmin", regA)
    const fin = await makeAdminSession("finance", regA)
    try {
      const res = await app.request("http://x/admin-api/rbac", {
        method: "PUT", headers: root.headers,
        body: JSON.stringify({
          finance: [...ROLE_PERMISSIONS.finance, "user.read"],
          ops: [...ROLE_PERMISSIONS.ops],
          support: [...ROLE_PERMISSIONS.support],
        }),
      })
      expect(res.status).toBe(200)
      expect((await app.request("http://x/admin-api/users?page=1&pageSize=10", { headers: fin.headers })).status).toBe(200)
    } finally {
      await restoreDefaults()
    }
    expect((await app.request("http://x/admin-api/users?page=1&pageSize=10", { headers: fin.headers })).status).toBe(403)
  })

  it("未知权限点 / admin.manage 外配 / 缺角色 → 400 invalid_rbac，不落库", async () => {
    const root = await makeAdminSession("superadmin", regA)
    const base = { finance: [], ops: [], support: [] }
    for (const bad of [
      { ...base, finance: ["no.such.perm"] },
      { ...base, ops: ["admin.manage"] },
      { finance: [], ops: [] },                        // 缺 support
    ]) {
      const res = await app.request("http://x/admin-api/rbac", {
        method: "PUT", headers: root.headers, body: JSON.stringify(bad),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_rbac")
    }
    const [row] = await getDb().select().from(billingConfigs).where(eq(billingConfigs.key, RBAC_CONFIG_KEY))
    expect(row).toBeUndefined()                        // 全被拒,没落库
  })

  it("非 superadmin PUT /rbac → 403（admin.manage 才能改矩阵）", async () => {
    const ops = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/rbac", {
      method: "PUT", headers: ops.headers,
      body: JSON.stringify({ finance: [], ops: [], support: [] }),
    })
    expect(res.status).toBe(403)
  })
})

describe("账本页用户选择器（QA:财务有 ledger.read 无 user.read,整页不可用）", () => {
  it("财务可用 /ledger/user-options（打码手机号）,全量用户接口仍 403", async () => {
    await restoreDefaults()
    const fin = await makeAdminSession("finance", regA)
    const res = await app.request("http://x/admin-api/ledger/user-options", { headers: fin.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; name: string }[] }
    // 展示名不含完整 11 位手机号（昵称或打码 138****1234）
    for (const it of body.items.slice(0, 20)) expect(it.name).not.toMatch(/1\d{10}/)
    expect((await app.request("http://x/admin-api/users?page=1&pageSize=10", { headers: fin.headers })).status).toBe(403)
  })
})
