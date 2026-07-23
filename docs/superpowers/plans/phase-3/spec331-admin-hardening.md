# spec331 · 运营后台加固（密钥脱敏 + 列表性能 + 契约健壮性）实现计划

**来源：** 《运营管理后台功能与性能测试报告》（2026-07-23，接口直连采样）。报告提 3 个问题 + 2 处性能偏慢。
执行前已逐条**核实真伪**（容器内实测），spec 只做真实存在的修复,误报只做无害加固,不动数据：

| 报告项 | 核实结论 | 处置 |
|---|---|---|
| #1 `plans/configs` 返回 `agent_model.models[].apiKey` 明文 | **真 · 高危**：`GET /configs` 走裸 `getConfigs()` 直吐 `billing_configs` 全表,含模型密钥明文（`/models` 有 `maskModelConfig` 脱敏,此路径漏了） | **必修**：configs 出参统一脱敏 |
| #2 多接口中文乱码 | **误报**：容器内实测 DB `server_encoding=UTF8`,套餐名「免费版/个人版/专业版」、反馈中文**存储与返回均正确**;报告作者采样工具（curl→GBK 终端）把 UTF-8 当本地编码解 = 客户端 mojibake | 不动数据;仅给 JSON 响应显式补 `charset=utf-8`（无害加固,帮严格客户端） |
| #3 `ledger/:userId/check` 的 `userId` 返回成账本 id | **误报**：路由是 `/:userId/check`,报告把**账本记录 id** 当 userId 传入,接口原样回显该路径参数 → 契约没错,是测试传错 ID | 加入参存在性校验:userId 查无此人 → 404,避免"拿任意 id 都返回 consistent:true"误导 |
| 性能 `orders` avg 316ms / `audit-logs` 130ms | **真 · 待优化**：需实测定位（N+1 / 缺索引 / 序列化） | 优化,目标压到 <100ms |

## 设计

- **#1 密钥脱敏（钱/安全红线）**：`GET /admin-api/plans/configs` 出参前,对 `agent_model`（及任何含 models[] 的模型配置键）复用 `model-config.ts` 既有 `maskModelConfig`——只出 `apiKeyHint`,`apiKey` 明文永不出服务端。
  写路径不变（前端本就用 hint 展示、apiKey 仅在保存时上行）。顺带排查：configs 响应是否被前端 localStorage 缓存 / 落日志（grep admin 端）。
- **charset 加固**：Hono 全局响应中间件给 `application/json` 补 `; charset=utf-8`（一处 middleware,不逐路由改）。这是纯防御,不改任何字节。
- **#3 入参校验**：`checkBalance(userId)` 前 `getUserById` 存在性校验,查无 → 404 `user_not_found`;避免运营拿错 id 得到假"一致"结论。
- **性能**：先加诊断（`orders`/`audit-logs` 列表查询打印 SQL 与耗时,定位是关联 N+1 还是全表扫）→ 按定位结果加**部分/复合索引**或**改分页查询**（退款数组若是逐单 N+1 → 批量 in 查询）。审计日志按 `created_at desc` 分页需 `(created_at)` 或 `(target, created_at)` 索引。**只加索引/改查询,不改契约**。

## Tasks（TDD,apps/api 单一服务；测试自建 Hono + 真库）

- [ ] T1 密钥脱敏：`plans/configs` 出参过 `maskConfigs`（含 models[] 的键走 maskModelConfig,其余原样）;真库测试——种一份带 apiKey 的 agent_model → GET 断言响应含 apiKeyHint、**不含** apiKey 明文;其余配置键原样返回。排查前端缓存/日志泄漏点。
- [ ] T2 charset 加固：全局 middleware 给 JSON 响应补 charset=utf-8;测试断言 Content-Type 含 `charset=utf-8`,中文体字节不变。
- [ ] T3 ledger check 入参校验：userId 无此人 → 404;真库测试（存在→200 原契约不变;不存在→404）。
- [ ] T4 性能诊断+优化：给 orders/audit-logs 列表加临时耗时/SQL 日志（或本地 explain）定位瓶颈 → 加索引（手写迁移 00NN + journal,当前最高 0029→0030）或改查询消 N+1;真库前后耗时对比记进本 spec。
- [ ] T5 收尾：mbp 全量相关套件绿 → 部署 230（api 原生）→ 容器内验证 configs 无明文密钥;勾账;docs 镜像 mbp。

## 验收

- `GET /admin-api/plans/configs` 响应**不含任何 apiKey 明文**,模型条目只有 apiKeyHint;写配置/保存模型链功能不变。
- 所有 admin-api JSON 响应 Content-Type 带 charset=utf-8;中文字段字节零变化（乱码本就是客户端问题,后台页面一直正常）。
- `ledger/:userId/check` 传不存在的 id → 404,传真实 userId → 原契约结果不变。
- `orders`、`audit-logs` 列表 P95 压到 <100ms（或记录实测瓶颈与优化前后数据）。
- 全程只读契约不破坏,钱路径零改动,无数据迁移改动业务数据。
