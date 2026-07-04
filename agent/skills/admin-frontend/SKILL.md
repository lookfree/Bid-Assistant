---
name: admin-frontend-dev
description: 开发/迭代运营管理后台前端（apps/admin，Next.js，:3001）时使用——概览/用户/订单/账本/套餐&配置/系统六页、登录守卫、RBAC、接 /admin-api。新增后台页/接线 admin-api/改权限守卫时读。
---

# 运营后台前端开发（apps/admin）

运营人员用的管理后台。**身份与 C 端完全隔离**（独立子域 `admin.`、独立会话、独立登录）。

## 技术栈与结构

- Next.js（端口 3001）+ shadcn/ui（与 C 端同套组件）。基于 `docs/admin-front` 原型。
- `app/(admin)/*`：仪表盘外壳（`(admin)/layout.tsx` = SidebarProvider + AppSidebar + AdminHeader）+ 六页 overview/users/orders/ledger/plans/system。`app/login` 账号密码登录页。
- `lib/admin-token-store.ts`（key **`bid.admin.token`**，与 C 端 `bid.token` 隔离）；`lib/admin-api.ts`（base `/admin-api`，Bearer，`AdminApiError` 带 status）；`components/RequireAdmin.tsx`（登录守卫）。

## 关键约定

1. **与 C 端隔离**：token key、api base、登录方式（账号密码，不是手机验证码）全独立。绝不复用 C 端 `bid.token`/`/api`。
2. **登录守卫**：`(admin)/layout.tsx` 用 `<RequireAdmin>` 包裹——未登录跳 `/login`；**仅 401 才清 token 跳转**，瞬时错误（5xx/网络）乐观放行（`AdminApiError.status===401` 判定），catch 受 alive 守卫防卸载竞态。
3. **RBAC**：后端按角色（superadmin/finance/ops/support）+ `requirePermission` 判权，support 对写操作全 403。前端按 `me()` 的 role 决定菜单/按钮可见性；真正的权限由后端把关（前端隐藏只是体验）。
4. **复用原型**：仪表盘/侧边栏/KPI/图表/六页布局都用现成原型，只把 mock 数据切到真实 `/admin-api` 端点（`GET /admin-api/overview|users|orders|ledger|plans|admins|audit-logs|diffs`，写操作 POST/PUT/PATCH）。原型不够的才加。
5. **金额**：`*_cents` → 展示除 100。分页响应 `{items,total,page,pageSize,hasMore}`。

## 对应的后端 admin-api（spec309 地基 + spec310 页面）

- 概览 `GET /overview`；用户 `GET /users`,`/users/:id`,`POST /users/:id/{ban,unban,credits}`；订单 `GET /orders`,`/orders/:id`,`POST /refunds`；账本 `GET /ledger`,`/ledger/:userId/check`；套餐&配置 `GET/POST/PUT /plans`,`GET /plans/configs`,`PUT /plans/configs/:key`；系统 `GET/POST/PUT /admins`,`GET /audit-logs`；差异工作台 `GET /diffs`,`PATCH /diffs/:id/resolve`,`POST /diffs/:id/fix-unknown-paid`。
- 调积分 body 必带客户端生成的 `idempotencyKey`（防双击重复给钱）。

## 命令与测试

```bash
bun run admin      # :3001
bun test test/     # 纯函数（如 admin-token-store）；tsconfig exclude test
```

首个超管由后端 `bun run admin:bootstrap`（apps/api）建。迭代节奏、提交规范同仓库。
