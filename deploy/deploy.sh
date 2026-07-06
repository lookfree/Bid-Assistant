#!/usr/bin/env bash
# 在目标机执行：拉最新代码 → 构建 → 跑 DB 迁移（一次性容器，独立于服务启动）→ 起/更新服务。
set -euo pipefail
cd "$(dirname "$0")"

# 全部逻辑包进函数：bash 解析完整个函数体才执行，
# 避免第 1 步 git pull 更新本脚本后、bash 继续按旧文件偏移读到错乱指令。
main() {

# 1) 拉代码（就地构建；或改为 CI 推镜像后 pull 镜像）
git -C .. pull --ff-only

# 2) 先构建镜像：migrate/seed 必须跑**新代码**的一次性容器——
#    旧镜像里没有新迁移 SQL/新脚本，先 run 后 build 会用旧镜像静默漏迁移或直接报脚本不存在。
docker compose --env-file .env.deploy.local build

# 3) 数据库迁移：用 api 镜像跑一次性容器，幂等（drizzle 只应用未应用的迁移）
docker compose --env-file .env.deploy.local run --rm api bun run db:migrate

# 3.5) 基础业务种子：billing_configs（credit_cost.* 等）+ plans 会员套餐。
#      幂等——已存在的键/档位跳过，绝不覆盖运营后台已改的价格/口径，故可每次部署都跑。
docker compose --env-file .env.deploy.local run --rm api bun run db:seed

# 4) 起/更新服务（镜像已在第 2 步构建，此处直接滚动更新）
docker compose --env-file .env.deploy.local up -d
docker compose ps

}
main "$@"
