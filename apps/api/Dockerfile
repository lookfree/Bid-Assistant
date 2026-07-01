FROM oven/bun:1.3-alpine
WORKDIR /app
# monorepo：复制全仓（.dockerignore 已排除 node_modules/.next）
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 8080
# 迁移在部署流程单独跑（见 deploy.sh）；容器只起服务
CMD ["bun", "run", "src/index.ts"]
