# spec332 · 会员中心开发票功能实现计划

**来源：** ONES 缺陷 YFZQ-3「会员中心开发票功能未实现」。核实后**不是 bug 而是缺功能**——
会员页 `开发票` 卡片（`apps/web/app/(tool)/membership/page.tsx:398-407`）只有一个**无 `onClick` 的死按钮**，
PRD 仅一句「支付：会员订阅与积分充值的支付与发票」（`docs/PRD.md:264`），后端/库/管理端**零实现**。本 spec 从零补齐。

| 现状核实 | 结论 | 处置 |
|---|---|---|
| C 端 `申请开票` 按钮 | 静态桩,点击无反应 | 接线到真实开票流程 |
| `payment_orders` 及全库 | **无任何发票字段**（grep 发票/fapiao/invoice/抬头/税号 仅命中上述死卡片 + PRD 一行） | 新建 `invoice_requests` 表（迁移 0031） |
| 管理端订单/API | 无发票 UI/接口 | 照搬退款模式（RBAC + 审计 + POST 动作 + 详情弹窗）补运营侧开票 |

## 开放决策（执行前请确认；已给推荐默认，spec 按推荐设计）

1. **开票方式**：
   - **(推荐·本期) 运营手工开票**——用户提交开票申请 → 运营在后台看到 → 用自有税控/开票系统**线下开具** → 回填发票号(+可选 PDF) → 标记「已开票」。**不接三方**，零外部依赖，契合客户验证阶段。
   - (后续可选) 对接三方电子发票 API（诺诺/百望/航信）**自动开具并邮件送达**——需票据服务商账号与密钥，客户侧未必已具备。设计上 `invoice_requests` 预留 `invoice_no`/`file_url`，未来加一个「自动开具」适配器即可平滑升级，不改表结构。
2. **发票类型**：**(推荐) 增值税电子普通发票**（个人/企业抬头均可）。增值税专用发票需购方一般纳税人资质与更多字段，本期不做。
3. **粒度**：**(推荐) 一单一票**（每个已支付订单最多一张有效发票；驳回后可重新申请）。合并多单开一票本期不做。
4. **抬头复用档案**：本期不做「保存常用抬头」，每次申请手填（可用浏览器自动填充）。后续按需再加。

> 钱的边界：发票只**引用订单、快照订单金额**，绝不触碰积分/余额账本——开票是运营记录，非资金变更。金额一律取服务端订单快照，不信客户端传值。

## 设计

### 数据模型（迁移 0031，手写 + journal 追加，当前最高 0030→0031）

新表 `invoice_requests`：
- `id`(uuid PK) · `user_id`(FK users, cascade) · `order_id`(FK payment_orders)
- `amount_cents`(int, 快照=订单金额, CHECK >0) · `title_type`(personal|enterprise) · `title`(抬头名) · `tax_no`(税号,企业必填,应用层校验) · `email`(收票邮箱) · `remark`(备注,可空)
- `status`(pending|issued|rejected, 默认 pending) · `invoice_no`(开具后回填) · `file_url`(电子发票 PDF,可空,MinIO) · `reject_reason`(驳回原因) · `handled_by`(运营账号) · `handled_at`(tz)
- `created_at`
- CHECK 约束：`title_type`、`status`、`amount_cents>0`
- **部分唯一索引** `UNIQUE(order_id) WHERE status IN ('pending','issued')`——防同一订单重复开票，同时允许**驳回后重新申请**。

### App API（钱与鉴权唯一层）

C 端（`/api/invoices`，`authMiddleware`）：
- `POST /api/invoices` `{orderId,titleType,title,taxNo?,email,remark?}`：校验 ①订单属本人 ②`status='paid'` ③无进行中/已开发票 → 服务端取订单 `amount_cents` 快照建 pending。企业抬头缺 `taxNo` → 400。重复 → 409 `invoice_exists`。
- `GET /api/invoices`：列本人开票申请（连订单类型/金额/时间），分页统一 `parsePagination`/`pagedBody`。

管理端（`/admin-api/invoices`，与 C 端隔离）：
- `GET /admin-api/invoices?status=&userId=`：列表 + 筛选，`requirePermission('invoice.write')`。
- `PATCH /admin-api/invoices/:id`：`{action:'issue',invoiceNo,fileUrl?}` 或 `{action:'reject',reason}` → 改 status/handledBy/handledAt，**`writeAudit`**（action `invoice.issue`/`invoice.reject`）。仅 pending 可流转（已终态再操作 409）。

RBAC：新增权限 `invoice.write`，授予 `superadmin` + `finance`（发票属财务）。`services/rbac` 权限表 + `admin-labels.ts` 中文名同步补 `invoice.write`「开具发票」、审计 action `invoice.issue`「开具发票」/`invoice.reject`「驳回开票」。

### C 端 UI（`apps/web`）

- 会员页死卡片 `开发票` 接线：`申请开票` → 弹窗（选一张**已支付且未开票**的订单 + 抬头类型/抬头/税号/邮箱/备注）提交。
- 订单记录列表（`membership/page.tsx` 订单行）为 `status==='paid'` 行加 `申请发票`（已申请显示状态）。
- 新增「我的发票」列表：状态徽标 待开票/已开票/已驳回；已开票显示发票号(+下载,若有 file_url)；已驳回显示原因（可重新申请）。
- API 封装进 `apps/web/lib/membership-api.ts`（`createInvoice`/`fetchInvoices`），类型进 `membership-types.ts`。

### 管理端 UI（`apps/admin`）

- 新增 `发票管理` 页 `app/(admin)/invoices/page.tsx` + `components/admin/invoices/invoices-client.tsx`：列表（状态筛选,`Select` 带 `items` 中文映射）+ 详情弹窗（用户/订单/抬头/税号/邮箱/金额 + `开具`(填发票号,可选上传 PDF)/`驳回`(填原因) 动作）。
- 侧栏导航加入口；`adminApi.invoices.{list,handle}` 进 `apps/admin/lib/admin-api.ts`。

## Tasks（TDD；App API 自建 Hono + 真库；前端 typecheck + 组件测试）

- [x] T1 迁移 0031 + schema：`invoice_requests` 表（含 CHECK + 部分唯一索引）+ Drizzle `invoiceRequests` 定义（`columns` helper，非 pgEnum）+ journal 追加。经隧道应用到远程库,`\d invoice_requests` 确认约束/索引存在。
- [x] T2 App API C 端：`invoicesRoutes()` + `services/invoices.ts`（createInvoiceRequest/listUserInvoices）。真库测试——已支付订单可建 pending;非本人订单 403;未支付 400 `order_not_paid`;企业抬头缺税号 400;重复申请 409;驳回后可再建。（7 测试绿）
- [x] T3 App API 管理端 + RBAC：`invoice.write` 权限入 rbac（superadmin+finance）;`/admin-api/invoices` 列表(筛选)+ PATCH issue/reject（落审计,仅 pending 可流转,终态 409）。真库测试——finance 可开/驳,ops 403;issue 回填发票号且审计含 invoice.issue;reject 记原因。（5 测试绿）
- [x] T4 C 端 UI：会员页死按钮接线 + 申请弹窗（企业抬头显示税号必填校验）+ 「我的发票」状态列表 + 订单行 `申请发票`。`membership-api` 封装。web typecheck + 关键交互测试（提交成功/校验失败）。（web 8 测试绿）
- [x] T5 管理端 UI：发票管理页 + 详情弹窗（开具/驳回）+ 导航入口 + `admin-labels` 中文映射（权限项/审计操作）。admin typecheck + 组件测试。（admin 59 测试绿）
- [x] T6 收尾：相关套件绿 → 部署 230（api 原生 + migrate 0031→231 + web/admin buildx）→ 容器内验证表已建、路由已挂载。勾账;docs 镜像 mbp。

## 验收

- 会员页 `申请开票` 可用：选已支付订单 + 填抬头/邮箱 → 生成待开票记录;企业抬头强制税号;同一订单不可重复开（驳回后可重申）。
- 运营在 `发票管理` 看到申请,可开具（回填发票号+可选 PDF）或驳回（记原因）;每次流转落**审计**（invoice.issue/reject），权限仅 superadmin+finance。
- C 端「我的发票」实时反映 待开票/已开票/已驳回;已开票显示发票号（+下载,若有）。
- **发票金额恒等于订单快照金额**,全程**不产生任何积分/余额变更**,不写 `credit_transactions`。
- 权限项/审计操作在后台**显示中文**（复用 admin-labels）。

## 执行记录（2026-07-23）

- **开放决策已确认**：用户确认「运营手工开票、不接三方票据」。设计按此落地。
- **后端**：T1 表 `invoice_requests`（迁移 0031，money-blind、部分唯一索引一单一票）；T2 C 端 `/api/invoices`（7 测试）；T3 管理端 `/admin-api/invoices` + RBAC `invoice.write`（superadmin+finance，5 测试）。金额一律取订单快照，绝不写 `credit_transactions`。
- **前端**：T4 会员页 `申请开票` 死按钮接线 + 申请弹窗（企业强制税号）+「我的发票」状态列表（web 8 测试）；T5 后台新增「发票管理」页（列表+筛选+开具/驳回弹窗）+ 导航 + `admin-labels` 补 invoice.write/invoice.issue/invoice.reject 中文（admin 59 测试）。
- **部署（230/231）**：**踩坑**——首次部署遇 230 磁盘 100% 满（Docker 镜像堆积 70GB），tar 同步/api build 全 `No space left on device`，且旧容器空跑 migrate 误报 success。`docker image prune -af && docker builder prune -af` 回收 ~64GB 后重跑。**迁移正解**：新 api 镜像 up 后 `docker exec bid-api-1 bun run drizzle-kit migrate` 应用 0031 到 231。容器内实测：231 有 `invoice_requests`（16 列 + `invoice_requests_active_order_uniq` 部分唯一索引），C 端/管理端路由均 401（已挂载）。见记忆 [[spec332-invoice-progress]]、[[bidsaas-230-cust-deploy]]。
