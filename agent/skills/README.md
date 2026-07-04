# 开发 Skills（投标智能体 SaaS）

按系统分层沉淀的开发知识,供 Claude Code 后续迭代/完善各部分时快速上手——含每层的技术栈、结构、**非显而易见的约定与踩坑**、命令、测试方式、迭代节奏。内容来自 Phase 0–3（含商业化 + 运营后台 + 推荐引擎）从零建设的实战积累。

## 目录

| Skill | 覆盖 | 何时用 |
|---|---|---|
| [`api-service/`](api-service/SKILL.md) | App API（`apps/api`，Hono+Bun+Drizzle+PG）| 动钱/鉴权/账本/支付/订阅/推荐/运营 API、新增路由/服务/仓储/schema/迁移、写测试 |
| [`web-frontend/`](web-frontend/SKILL.md) | C 端前端（`apps/web`，Next.js+React+Tailwind+shadcn）| 投标工具流、会员中心、登录、接后端接口 |
| [`admin-frontend/`](admin-frontend/SKILL.md) | 运营后台前端（`apps/admin`，Next.js :3001）| 六页后台、登录守卫、RBAC、接 `/admin-api` |
| [`agent-service/`](agent-service/SKILL.md) | 智能体服务（`services/agent`，Python+FastAPI+LangGraph）| bidding_agent 工作流、节点/提示词/Pydantic schema、新增智能体 |
| [`deployment/`](deployment/SKILL.md) | 部署/运维 | mbp 隧道跑测试与迁移、收钱吧回调反代、密钥、docs 同步、数据拓扑 |

## 贯穿全局的铁律（每个 skill 都会重申）

- **钱只在 App API 动**：余额 = Σ append-only `credit_transactions`；每笔带幂等键；金额整数分禁浮点；智能体只上报用量。
- **和钱相关的要严谨**：并发串行化（行锁）、幂等、封顶、退款歧义转 pending、审计留痕。
- **集成测试连真库 → 必经 `./test-on-mbp.sh`（mbp SSH 隧道）**，别本机直连远程 PG。
- **迁移手写 + 手动 append journal**（drizzle snapshot 停在 ~0017，`db:generate` 会污染）。
- **迭代节奏**：实现（TDD）→ `/code-review`（全修）→ `/simplify` → mbp/tsc 全绿 → 合并 main + 推送。
- **提交规范**：英文 Conventional Commits、账号 `lookfree`、**不加 Co-Authored-By**。

## 用法

后续要迭代哪部分,先读对应目录的 `SKILL.md`(有 frontmatter 的 `description` 标注了「何时用」)。若要让 Claude Code 自动发现这些 skill,可把本目录软链/复制到 `.claude/skills/`。
