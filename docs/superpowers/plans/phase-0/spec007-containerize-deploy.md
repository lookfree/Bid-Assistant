# spec007 · 容器化与部署 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三个无状态应用（api/web/admin）容器化，用 Docker Compose 编排，Nginx 反代按**双子域**（`app.` / `admin.` / `api.`）路由（架构 §3.3/§13），并加 GitHub Actions CI（起服务容器跑迁移 + 测试 + 构建）。中间件（PG/Redis/MinIO）复用已部署的裸机实例（§13.1），不进 compose。

**Architecture:** 单副本起步档（§13.5）：每个 app 一个容器；Nginx 双活入口按子域分流到 web/admin/api；app 通过环境变量连外部中间件（`60.205.160.74` 上的 PG16/Redis/MinIO）。CI 用 service containers（pgvector/redis/minio）让集成测试可跑。

**Tech Stack:** Docker（`oven/bun` 镜像）、Docker Compose、Nginx、GitHub Actions。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 中间件**不进 compose**（裸机外部，§13.1）；app 容器经 env 连外部地址。
- 真实密钥不入库：compose 用 `--env-file` 或 server 上的 `.env`（gitignore）；CI 用 Actions Secrets。
- 双子域而非对外暴露不同端口（§3.3）；后台子域后续加 IP 白名单。
- 单副本起步（§13.5）；镜像用 `oven/bun`（§2.2 纪律4）。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
仓库根/
├── .dockerignore                       # 新
├── apps/api/Dockerfile                 # 新（oven/bun）
├── apps/web/Dockerfile                 # 新（bun 构建 + next start）
├── apps/admin/Dockerfile               # 新
├── apps/web/next.config.mjs            # 改：output 标准（按需）
├── deploy/
│   ├── docker-compose.yml              # 新：api/web/admin/nginx
│   ├── .env.deploy.example             # 新：compose 变量模板（真实值入 .env.deploy.local）
│   └── nginx/conf.d/bid.conf           # 新：双子域反代
└── .github/workflows/ci.yml            # 新：CI（service containers + 迁移 + 测试 + 构建）
```

---

## Task 1: 三个 Dockerfile + .dockerignore

**Files:**
- Create: `.dockerignore`、`apps/api/Dockerfile`、`apps/web/Dockerfile`、`apps/admin/Dockerfile`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec007-deploy
```

- [ ] **Step 2: 写根 `.dockerignore`**

```gitignore
node_modules
**/node_modules
**/.next
.git
**/.env*.local
*.md
dist
```

- [ ] **Step 3: 写 `apps/api/Dockerfile`**

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
# monorepo：复制全仓（.dockerignore 已排除 node_modules/.next）
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 8080
# 迁移在部署流程单独跑（见 Task 4）；容器只起服务
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 4: 写 `apps/web/Dockerfile`**

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# NEXT_PUBLIC_* 构建期注入（同源 API 用相对路径时可省）
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_CAPTCHA_ENABLED=false
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL NEXT_PUBLIC_CAPTCHA_ENABLED=$NEXT_PUBLIC_CAPTCHA_ENABLED
RUN bun --filter @bid/web run build
WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "run", "start"]
```

- [ ] **Step 5: 写 `apps/admin/Dockerfile`（同构，端口 3001）**

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN bun --filter @bid/admin run build
WORKDIR /app/apps/admin
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
CMD ["bun", "run", "start"]
```

- [ ] **Step 6: 本地构建验证（api 镜像最快）**

Run: `docker build -f apps/api/Dockerfile -t bid-api:dev .`
Expected: 构建成功（`bun install` + 镜像产出）。

- [ ] **Step 7: 提交**

```bash
git add .dockerignore apps/*/Dockerfile
git commit -m "feat(spec007): api/web/admin Dockerfile + .dockerignore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Docker Compose（app 层）+ env 模板

**Files:**
- Create: `deploy/docker-compose.yml`、`deploy/.env.deploy.example`

- [ ] **Step 1: 写 `deploy/.env.deploy.example`（变量模板，真实值入 `.env.deploy.local`，不入库）**

```bash
# 镜像 tag
TAG=latest
# 外部中间件（裸机，§13.1）—— 真实值见根 .env.bidsaas.local
DATABASE_URL=postgresql://bidsaas:***@60.205.160.74:5432/bidsaas
REDIS_HOST=60.205.160.74
REDIS_PORT=6379
REDIS_PASSWORD=***
REDIS_DB=3
REDIS_KEY_PREFIX=bid:
MINIO_ENDPOINT=http://60.205.160.74:9000
MINIO_ACCESS_KEY=thinkAI
MINIO_SECRET_KEY=***
MINIO_BUCKET=bidsaas
# 业务
WEB_ORIGINS=https://app.example.com,https://admin.example.com
CAPTCHA_ENABLED=true
PUBLIC_API_BASE_URL=https://api.example.com
```

- [ ] **Step 2: 写 `deploy/docker-compose.yml`**

```yaml
name: bid
services:
  api:
    build: { context: .., dockerfile: apps/api/Dockerfile }
    image: bid-api:${TAG}
    restart: unless-stopped
    env_file: [.env.deploy.local]
    expose: ["8080"]

  web:
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
      args: { NEXT_PUBLIC_API_BASE_URL: "${PUBLIC_API_BASE_URL}" }
    image: bid-web:${TAG}
    restart: unless-stopped
    expose: ["3000"]

  admin:
    build:
      context: ..
      dockerfile: apps/admin/Dockerfile
      args: { NEXT_PUBLIC_API_BASE_URL: "${PUBLIC_API_BASE_URL}" }
    image: bid-admin:${TAG}
    restart: unless-stopped
    expose: ["3001"]

  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on: [api, web, admin]
    ports: ["80:80"]   # 生产再挂 443 + 证书
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
```

> compose 文件在 `deploy/`，`context: ..` 指向仓库根（让 Dockerfile 能 COPY 整个 monorepo）。

- [ ] **Step 3: 提交**

```bash
git add deploy/docker-compose.yml deploy/.env.deploy.example
git commit -m "feat(spec007): app 层 docker-compose + env 模板(连外部中间件)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Nginx 双子域反代

**Files:**
- Create: `deploy/nginx/conf.d/bid.conf`

- [ ] **Step 1: 写 `deploy/nginx/conf.d/bid.conf`**

```nginx
# C 端用户前端
server {
  listen 80;
  server_name app.example.com;
  client_max_body_size 5m;            # 文件走 MinIO 直传，这里仅 API/SSR
  location / { proxy_pass http://web:3000; include /etc/nginx/conf.d/_proxy.inc; }
}

# 运营管理后台（后续加 IP 白名单 allow/deny）
server {
  listen 80;
  server_name admin.example.com;
  location / { proxy_pass http://admin:3001; include /etc/nginx/conf.d/_proxy.inc; }
}

# App API
server {
  listen 80;
  server_name api.example.com;
  location / { proxy_pass http://api:8080; include /etc/nginx/conf.d/_proxy.inc; }
}
```

- [ ] **Step 2: 写共享代理头 `deploy/nginx/conf.d/_proxy.inc`**

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;          # SSE/WebSocket
proxy_set_header Connection "";
proxy_buffering off;                              # SSE 流式不缓冲
proxy_read_timeout 300s;
```

> `X-Forwarded-For` 透传给 API（spec004 取客户端 IP 做防刷、spec006 记 IP）。SSE 用 `proxy_buffering off`（为 Phase 1 智能体流式预留）。

- [ ] **Step 3: 本地用 hosts 验证（无需真域名）**

```bash
# /etc/hosts 加：127.0.0.1 app.example.com admin.example.com api.example.com
cd deploy && cp .env.deploy.example .env.deploy.local   # 填真实中间件密钥（从根 .env.bidsaas.local 拷）
docker compose up -d --build
curl -s -H 'Host: api.example.com' http://localhost/healthz   # 期望 {"status":"ok"}
curl -s -i -H 'Host: app.example.com' http://localhost/ | head -1   # web 200
docker compose down
```
Expected: 三子域分别命中 api/web/admin。

- [ ] **Step 4: 提交**

```bash
git add deploy/nginx
git commit -m "feat(spec007): Nginx 双子域反代(app/admin/api) + SSE/转发头

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 部署到服务器 + 迁移

**Files:**
- Create: `deploy/deploy.sh`

- [ ] **Step 1: 写 `deploy/deploy.sh`（在目标机执行）**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# 1) 拉代码（或 CI 推镜像；此处就地构建）
git -C .. pull --ff-only
# 2) 跑数据库迁移（容器外，用 api 镜像一次性容器）
docker compose --env-file .env.deploy.local run --rm api bun run db:migrate
# 3) 起/更新服务
docker compose --env-file .env.deploy.local up -d --build
docker compose ps
```

> 迁移**独立于服务启动**单独跑（幂等，drizzle migrate 只应用未应用的）。

- [ ] **Step 2: 部署前置（目标机一次性）**

- 目标机装 Docker + Compose 插件；
- `deploy/.env.deploy.local` 填好（连 `60.205.160.74` 的 PG/Redis/MinIO 真实密钥）；
- DNS 把 `app./admin./api.<域名>` A 记录指向目标机（生产需 ICP 备案 + 443 证书）。

- [ ] **Step 3: 执行部署 + 冒烟**

```bash
chmod +x deploy/deploy.sh && ./deploy/deploy.sh
curl -s https://api.<域名>/healthz   # {"status":"ok"}
curl -s https://api.<域名>/readyz    # {"status":"ready","db":"up"}
```
Expected: 迁移成功、三服务 Up、健康检查通过。

- [ ] **Step 4: 提交**

```bash
git add deploy/deploy.sh
git commit -m "feat(spec007): 部署脚本(迁移 + compose up)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: GitHub Actions CI + 合并

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: bidsaas, POSTGRES_PASSWORD: ci, POSTGRES_DB: bidsaas }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U bidsaas" --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
      minio:
        image: minio/minio:latest
        env: { MINIO_ROOT_USER: ci, MINIO_ROOT_PASSWORD: ci-secret12 }
        ports: ["9000:9000"]
        options: --health-cmd "mc ready local || exit 0"   # minio 容器无 mc，宽松健康检查
    env:
      DATABASE_URL: postgresql://bidsaas:ci@localhost:5432/bidsaas
      REDIS_HOST: localhost
      REDIS_PORT: "6379"
      REDIS_DB: "3"
      REDIS_KEY_PREFIX: "bid:"
      MINIO_ENDPOINT: http://localhost:9000
      MINIO_ACCESS_KEY: ci
      MINIO_SECRET_KEY: ci-secret12
      MINIO_BUCKET: bidsaas
      CAPTCHA_ENABLED: "false"
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.0 }
      - run: bun install --frozen-lockfile
      - name: 建 MinIO 测试桶
        run: |
          curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc
          mc alias set ci http://localhost:9000 ci ci-secret12
          mc mb --ignore-existing ci/bidsaas
      - name: 迁移
        run: cd apps/api && bun run drizzle-kit migrate
      - name: 类型检查
        run: bun --filter '*' typecheck
      - name: 测试
        run: cd apps/api && bun test
      - name: 前端构建
        run: bun --filter @bid/web run build && bun --filter @bid/admin run build
```

> CI 用 service containers 起 PG(pgvector)/Redis/MinIO，跑迁移后执行集成测试；密钥为 CI 专用假值，不碰生产。

- [ ] **Step 2: 本地校验 workflow 语法（可选）**

Run: `cat .github/workflows/ci.yml | head -1`（或用 `act` 试跑；至少确认 YAML 合法）
Expected: YAML 合法。

- [ ] **Step 3: 提交并合并（推送后 CI 自动跑）**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(spec007): GitHub Actions CI(service containers + 迁移 + 测试 + 构建)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec007-deploy -m "merge spec007: 容器化与部署"
git push origin main   # 触发 CI
```

---

## 验收清单（spec007 完成判据）

- [ ] api/web/admin 三镜像可构建（`oven/bun`）；`.dockerignore` 排除 node_modules/.next/.env*.local。
- [ ] `docker compose up` 起 api/web/admin/nginx；中间件连外部裸机（不在 compose）。
- [ ] Nginx 按 `app./admin./api.` 双子域分流；透传 `X-Forwarded-For`、SSE 不缓冲。
- [ ] `deploy.sh` 先跑 `db:migrate` 再 `up -d`；`/healthz`、`/readyz` 通过。
- [ ] CI 用 service containers（pgvector/redis/minio）跑迁移 + 集成测试 + 构建，全绿。
- [ ] 真实密钥不入库（compose 用 `.env.deploy.local`、CI 用假值/Secrets）。

---

## Phase 0 收尾

spec007 合并后，Phase 0「地基」目标达成：**能登录（手机号/微信）、能上传文件、能部署**。计费用 stub 占位（Phase 3 接真账本）。下一阶段进 **Phase 1**（智能体服务骨架 + 读标），见架构 §8。
