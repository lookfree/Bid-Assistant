#!/bin/bash
# 客户验证环境（230）发版。**在 mbp 上执行**：230 构建不了 web/admin（Next.js 构建要拉 Google Fonts，
# 客户网络出不去），故 api/agent 在 230 原生构建、web/admin 在 mbp 交叉构建 amd64 后投送镜像。
#
#   用法：bash deploy/deploy-cust.sh <短 commit> [--only api,agent]
#
# 此前每次发版都是临时手写脚本，迁移这一步全靠人记得——0041 之前的改动恰好都不带迁移，所以没暴露。
# 固化成脚本后，迁移是流程里的固定一步，不再是"这次要记得"。
set -o pipefail
export PATH=/usr/local/bin:$PATH

WANT="${1:?用法: deploy-cust.sh <短 commit> [--only api,agent]}"
ONLY="${2:-}"
SRC="${BID_SRC:-/Users/Administrator/bid}"
R230="${BID_R230:-angeek@192.168.106.230}"
R231="${BID_R231:-angeek@192.168.106.231}"   # 数据机：PG/Redis/MinIO/OCR
DC='docker compose -f docker-compose.cust.yml --env-file .env.deploy.local'
wants() { [ -z "$ONLY" ] || [[ ",${ONLY#--only }," == *",$1,"* ]]; }
abort() { echo "ABORT: $1"; exit 1; }

# 构建输出必须落文件再截取：成功时只要末几行，失败时要的是**报错原文**。
# 直接 `build | tail -2` 在失败时留下的恰好是 buildx 结尾的 "View build details:" URL，
# 真正的错误早被截掉——2026-08-07 的 web 构建失败就是这样查不出原因，重跑一遍才拿到。
run_build() {
  local what="$1" log="/tmp/build-$1.log"; shift
  if "$@" > "$log" 2>&1; then tail -2 "$log"; else tail -40 "$log"; abort "$what 构建失败"; fi
}

# mbp 是笔记本，发版期间没有键鼠活动、web/admin 的 amd64 交叉构建在 QEMU 下要十几分钟——
# 2026-08-07 就是构建到一半机器休眠、Tailscale 掉线，构建被杀。更糟的是若休眠发生在
# 「迁移已跑完、流量还没切」之间，线上会停在新库结构 + 旧代码。caffeinate 跟随本进程存活，
# 脚本一结束即释放。注意：合盖时 macOS 仍可能休眠，caffeinate 不是绝对保证，发版请开着盖子。
command -v caffeinate >/dev/null && caffeinate -dimsu -w $$ &

echo "=== start $(date) 目标 $WANT ==="

cd "$SRC" || abort "源码目录不存在 $SRC"
git fetch origin main --quiet && git merge --ff-only origin/main || abort "同步 origin/main 失败"
[ "$(git rev-parse --short HEAD)" = "$WANT" ] || abort "HEAD 不是 $WANT"

# 在途任务复查：部署会重启容器、打断用户正在跑的长任务（读标/正文动辄几十分钟）。
inflight() {
  ssh -o BatchMode=yes "$R230" 'docker exec bid-agent-api-1 uv run --no-sync python -c "
import os,psycopg
with psycopg.connect(os.environ[\"DATABASE_URL\"]) as c:
    print(\"INFLIGHT:\"+str(c.execute(\"select project_id,step from project_steps where status=(chr(114)||chr(117)||chr(110)||chr(110)||chr(105)||chr(110)||chr(103))\").fetchall()))
"' 2>/dev/null | grep -o 'INFLIGHT:.*' | sed 's/INFLIGHT://'
}
R1=$(inflight); echo "在途(开始前): [$R1]"
[ "$R1" = "[]" ] || abort "有在途任务或查不清，未动线上"

ssh -o BatchMode=yes "$R230" 'bash ~/bid/ops/tag-prev.sh 2>&1 | tail -5'   # 回滚点

echo "=== 同步源码到 230（含 deploy/ 下的 nginx 配置与 compose）==="
git archive --format=tar HEAD | ssh -o BatchMode=yes "$R230" 'tar xf - -C ~/bid/app' || abort "源码同步失败"

echo "=== nginx 配置语法校验（接 compose 网络才解析得到上游）==="
ssh -o BatchMode=yes "$R230" 'docker run --rm --network bid_default \
  -v /home/angeek/bid/app/deploy/nginx-ip:/etc/nginx/conf.d:ro --entrypoint sh \
  $(docker inspect bid-nginx-1 --format "{{.Config.Image}}") -c "nginx -t 2>&1" | tail -3' \
  || abort "nginx 配置校验失败，未动线上"

# 数据机（231）的 OCR 服务。镜像在 mbp 交叉构建 amd64 后投送——231 拉基础镜像走 Docker Hub
# 镜像源，实测 30MB 的层要十几分钟（40KB/s），与 web/admin 同样的理由走同一条投送路。
#
# **只起 ocr，绝不碰 postgres/redis/minio**：
#  - 它们是客户的活数据层，重启一次全站停；
#  - compose 里给它们加的资源限额会改变容器 spec，`up -d` 会**重建**它们；
#  - 且 ${POSTGRES_PASSWORD} 这类插值不来自 env_file，来自项目目录的 .env——231 上只有
#    .env.data，不显式 --env-file 的话会插成空串，等于用空密码重建库、关掉 Redis 鉴权。
# 数据层的限额要生效，由人另行择时执行（见 deploy/data/README 的说明），不能是发版的副作用。
if wants ocr; then
  echo "=== mbp 构建 ocr (amd64) 并投送 231 ==="
  run_build ocr docker buildx build ${BUILDER:+--builder $BUILDER} --platform linux/amd64 \
    -f services/ocr/Dockerfile -t bid-ocr:latest --load services/ocr
  docker image inspect bid-ocr:latest --format "ocr arch={{.Architecture}}"
  rm -f /tmp/bid-ocr.tar.gz
  docker save bid-ocr:latest | gzip > /tmp/bid-ocr.tar.gz || abort "ocr 导出失败"
  rsync -a --partial --inplace /tmp/bid-ocr.tar.gz "$R231:/tmp/bid-ocr.tar.gz" || abort "ocr 投送失败"
  ssh -o BatchMode=yes "$R231" "gunzip -c /tmp/bid-ocr.tar.gz | docker load && rm -f /tmp/bid-ocr.tar.gz" \
    || abort "ocr 加载失败"
  echo "=== 231 起 OCR（只此一个服务）==="
  scp -q deploy/data/docker-compose.data.yml "$R231":~/bid/data/docker-compose.yml || abort "231 compose 同步失败"
  ssh -o BatchMode=yes "$R231" 'cd ~/bid/data && TAG=latest docker compose --env-file .env.data up -d ocr 2>&1 | tail -4' \
    || abort "231 OCR 启动失败"
fi

echo "=== 230 原生构建 api + agent ==="
ssh -o BatchMode=yes "$R230" "set -o pipefail; cd ~/bid/app/deploy && export TAG=latest
$DC build api agent-api 2>&1 | tail -3" || abort "api/agent 构建失败"

if wants web || wants admin; then
  echo "=== mbp 交叉构建 web + admin (amd64) 并投送 ==="
  for app in web admin; do
    wants "$app" || continue
    run_build "$app" docker buildx build ${BUILDER:+--builder $BUILDER} --platform linux/amd64 \
      -f "apps/$app/Dockerfile" -t "bid-$app:latest" --load .
    docker image inspect "bid-$app:latest" --format "$app arch={{.Architecture}}"
    rm -f "/tmp/bid-$app.tar.gz"
    docker save "bid-$app:latest" | gzip > "/tmp/bid-$app.tar.gz" || abort "$app 导出失败"
    # rsync 而非 docker save | ssh docker load：那条管道在 SSH 断链后会假死（进程在、字节不动、
    # 无法续传），2026-08-05 卡了近一小时。rsync 断了能续、有速率、卡住看得出来。
    rsync -a --partial --inplace "/tmp/bid-$app.tar.gz" "$R230:/tmp/bid-$app.tar.gz" || abort "$app 投送失败"
    ssh -o BatchMode=yes "$R230" "gunzip -c /tmp/bid-$app.tar.gz | docker load && rm -f /tmp/bid-$app.tar.gz" \
      || abort "$app 加载失败"
  done
fi

# 迁移：一次性容器跑**新镜像**里的 drizzle-kit（迁移 SQL 与 drizzle-kit 都在 api 镜像内，
# WORKDIR=/app/apps/api 故 bun run db:migrate 能解析到本地 .bin）。
# 必须在切流量**之前**：新代码依赖新表结构，先切后迁会有一段时间报错。
echo "=== 应用数据库迁移 ==="
ssh -o BatchMode=yes "$R230" "cd ~/bid/app/deploy && export TAG=latest
$DC run --rm api bun run db:migrate 2>&1 | tail -6" || abort "迁移失败，未切流量"

R2=$(inflight); echo "在途(切流量前): [$R2]"
[ "$R2" = "[]" ] || abort "构建期间出现在途任务，未重启"

echo "=== 切流量 ==="
ssh -o BatchMode=yes "$R230" "set -o pipefail; cd ~/bid/app/deploy && export TAG=latest
$DC up -d api agent-api agent-worker web admin || exit 1
sleep 8
docker exec bid-nginx-1 nginx -s reload || $DC restart nginx
sleep 3
docker ps --format '{{.Names}} {{.Status}}' | head -8"

echo "=== 冒烟校验 ==="
# OCR 健康：不静默吞掉——它挂了插图就没有识别文字，审查又会看不出材料在不在
ssh -o BatchMode=yes "$R231" 'curl -s -o /dev/null -w "231 OCR 健康 %{http_code}\n" http://192.168.106.231:8100/health' \
  || echo "WARN: OCR 健康检查失败（插图仍可用，只是没有识别文字）"
ssh -o BatchMode=yes "$R230" '
curl -s -o /dev/null -w "C端首页 %{http_code}\n" http://127.0.0.1/
curl -s -o /dev/null -w "后台首页 %{http_code}\n" http://127.0.0.1:8081/
curl -s -o /dev/null -w "api鉴权(应401) %{http_code}\n" http://127.0.0.1/api/projects
docker image prune -f | tail -1; df -h / | tail -1'
echo "=== ALLDONE $(date) ==="
