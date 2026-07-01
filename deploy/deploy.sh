#!/usr/bin/env bash
# 在目标机执行：拉最新代码 → 跑 DB 迁移（一次性容器，独立于服务启动）→ 起/更新服务。
set -euo pipefail
cd "$(dirname "$0")"

# 1) 拉代码（就地构建；或改为 CI 推镜像后 pull 镜像）
git -C .. pull --ff-only

# 2) 数据库迁移：用 api 镜像跑一次性容器，幂等（drizzle 只应用未应用的迁移）
docker compose --env-file .env.deploy.local run --rm api bun run db:migrate

# 3) 起/更新服务
docker compose --env-file .env.deploy.local up -d --build
docker compose ps
