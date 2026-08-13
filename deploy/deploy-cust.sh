#!/bin/bash
# 客户验证环境（230）发版。**在 mbp 上执行**：230 构建不了 web/admin（Next.js 构建要拉 Google Fonts，
# 客户网络出不去），故 api/agent 在 230 原生构建、web/admin 在 mbp 交叉构建 amd64 后投送镜像。
#
#   用法：bash deploy/deploy-cust.sh <短 commit> ["--only api,agent,web"]
#         **--only 连值一起加引号**，不加会被当场拦下（见下方注释里的事故）。
#
# 这个脚本的每一条守护都对应一次真实事故，改动前先读对应的注释：
#   · --only 不加引号 → web 被静默跳过却照样 ALLDONE（2026-08-11）
#   · 构建吊死无上限   → 出网坏掉时卡 27 分钟，进程活着看不出来（2026-08-12）
#   · 切流量没有 abort → ssh 断链也能走到 ALLDONE，即「假 ALLDONE」本身
#   · 冒烟只打印不判断 → 502 也算发成功
#   · 没有后置验证     → 组件被跳过时无人发现
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
# 不带超时的 ssh 在断链后会**无限期挂着**：2026-08-07 那次发版启动 5 秒后 mbp 就合盖休眠，
# 进程还活着、日志停在第 3 行，卡在查在途任务的那条 ssh 上 40 分钟，不看进程根本发现不了。
# 宁可快速失败——脚本任何一步失败都 abort，且失败点全在切流量之前，重跑无害。
SSHOPT='-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4'
wants() { [ -z "$ONLY" ] || [[ ",${ONLY#--only[ =]}," == *",$1,"* ]]; }

# **--only 必须整体加引号**。不加的话 $2 恰好等于字面量 "--only"，${ONLY#--only } 剥不掉，
# wants 对每个组件都判 false —— web/admin 被静默跳过，而 api/agent 是无条件构建的，
# 于是脚本一路跑到 ALLDONE，用户以为发全了（2026-08-11 实测：web 没进去，靠事后比对
# 容器 Up 时间才发现）。这里当场拦下，不给它跑到 ALLDONE 的机会。
abort() { echo "ABORT: $1"; exit 1; }

[ "$ONLY" = "--only" ] && abort "--only 要作为**一个带引号的参数**传：\"--only api,agent,web\"（不加引号会静默跳过 web 却照样 ALLDONE）"
[ -n "${3:-}" ] && abort "多余参数 '${3}'：--only 及其值必须整体加引号"

# 构建输出必须落文件再截取：成功时只要末几行，失败时要的是**报错原文**。
# 直接 `build | tail -2` 在失败时留下的恰好是 buildx 结尾的 "View build details:" URL，
# 真正的错误早被截掉——2026-08-07 的 web 构建失败就是这样查不出原因，重跑一遍才拿到。
# 构建总时长上限。2026-08-12 实测：mbp 出网坏掉时 web 的交叉构建**吊死 27 分钟**——
# 进程活着、日志停在 `next build` 开头、buildx 累计 CPU 只有 0.23 秒，不去看 CPU 时间
# 根本判断不出它已经死了，人只会一直等。正常 web 交叉构建 3~6 分钟，15 分钟是宽裕的上限。
BUILD_TIMEOUT_S="${BUILD_TIMEOUT_S:-900}"

# macOS 自带没有 timeout(1)，自己盯：后台跑 + 轮询 + 到点杀。
run_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5; waited=$((waited + 5))
    if [ "$waited" -ge "$secs" ]; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124
    fi
  done
  wait "$pid"
}

run_build() {
  local what="$1" log="/tmp/build-$1.log"; shift
  run_timeout "$BUILD_TIMEOUT_S" "$@" > "$log" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then tail -2 "$log"; return; fi
  tail -40 "$log"
  [ "$rc" -eq 124 ] && abort "$what 构建超过 ${BUILD_TIMEOUT_S}s 仍无进展（多半是 mbp 出网断了，构建卡在拉依赖/字体）"
  abort "$what 构建失败"
}

# mbp 是笔记本，发版期间没有键鼠活动、web/admin 的 amd64 交叉构建在 QEMU 下要十几分钟。
# 若休眠发生在「迁移已跑完、流量还没切」之间，线上会停在新库结构 + 旧代码，故先堵住这条。
# caffeinate 跟随本进程存活，脚本一结束即释放。
#
# **但 caffeinate 挡不住合盖休眠**：2026-08-07 两次发版都死在这上面，pmset -g log 里是
# `Entering Sleep state due to 'Clamshell Sleep' ... Using Batt`——合盖且用电池时，
# caffeinate 的 assertion 不生效，之后每 15 分钟只有 42 秒的 DarkWake。
# 发版前请确认 mbp **接电源 + 开盖**（或临时 `sudo pmset -a disablesleep 1`）。
command -v caffeinate >/dev/null && caffeinate -dimsu -w $$ &

echo "=== start $(date) 目标 $WANT ==="

# 出网预检：web/admin 的 Next 构建要联网拉 Google Fonts（这正是它们只能在 mbp 构建、
# 230 出不去的原因）。mbp 出网一坏，构建就吊在那儿不动——2026-08-12 实测卡了 27 分钟，
# 而当时 registry.npmmirror.com 直接 8 秒超时、fonts 要 7.8 秒。与其等超时兜底，
# 不如开跑前一秒钟测出来：这一步失败，一个字节都还没动过线上。
if wants web || wants admin; then
  echo "=== mbp 出网预检（web/admin 构建要联网）==="
  for u in "https://registry.npmmirror.com" "https://fonts.googleapis.com/css2?family=Inter"; do
    read -r code secs <<<"$(curl -s -m 8 -o /dev/null -w '%{http_code} %{time_total}' "$u")"
    echo "  $u -> $code ${secs}s"
    [ "$code" = "200" ] || abort "mbp 出网异常（$u -> $code），web 构建必然吊死，先修网络再发"
  done
fi

cd "$SRC" || abort "源码目录不存在 $SRC"
git fetch origin main --quiet && git merge --ff-only origin/main || abort "同步 origin/main 失败"
[ "$(git rev-parse --short HEAD)" = "$WANT" ] || abort "HEAD 不是 $WANT"

# 在途任务复查：部署会重启容器、打断用户正在跑的长任务（读标/正文动辄几十分钟）。
inflight() {
  ssh $SSHOPT "$R230" 'docker exec bid-agent-api-1 uv run --no-sync python -c "
import os,psycopg
with psycopg.connect(os.environ[\"DATABASE_URL\"]) as c:
    print(\"INFLIGHT:\"+str(c.execute(\"select project_id,step from project_steps where status=(chr(114)||chr(117)||chr(110)||chr(110)||chr(105)||chr(110)||chr(103))\").fetchall()))
"' 2>/dev/null | grep -o 'INFLIGHT:.*' | sed 's/INFLIGHT://'
}
R1=$(inflight); echo "在途(开始前): [$R1]"
[ "$R1" = "[]" ] || abort "有在途任务或查不清，未动线上"

ssh $SSHOPT "$R230" 'bash ~/bid/ops/tag-prev.sh 2>&1 | tail -5'   # 回滚点

echo "=== 同步源码到 230（含 deploy/ 下的 nginx 配置与 compose）==="
git archive --format=tar HEAD | ssh $SSHOPT "$R230" 'tar xf - -C ~/bid/app' || abort "源码同步失败"

echo "=== nginx 配置语法校验（接 compose 网络才解析得到上游）==="
ssh $SSHOPT "$R230" 'docker run --rm --network bid_default \
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
  rsync -e "ssh $SSHOPT" -a --partial --inplace /tmp/bid-ocr.tar.gz "$R231:/tmp/bid-ocr.tar.gz" || abort "ocr 投送失败"
  ssh $SSHOPT "$R231" "gunzip -c /tmp/bid-ocr.tar.gz | docker load && rm -f /tmp/bid-ocr.tar.gz" \
    || abort "ocr 加载失败"
  echo "=== 231 起 OCR（只此一个服务）==="
  scp $SSHOPT -q deploy/data/docker-compose.data.yml "$R231":~/bid/data/docker-compose.yml || abort "231 compose 同步失败"
  ssh $SSHOPT "$R231" 'cd ~/bid/data && TAG=latest docker compose --env-file .env.data up -d ocr 2>&1 | tail -4' \
    || abort "231 OCR 启动失败"
fi

echo "=== 230 原生构建 api + agent ==="
ssh $SSHOPT "$R230" "set -o pipefail; cd ~/bid/app/deploy && export TAG=latest
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
    rsync -e "ssh $SSHOPT" -a --partial --inplace "/tmp/bid-$app.tar.gz" "$R230:/tmp/bid-$app.tar.gz" || abort "$app 投送失败"
    ssh $SSHOPT "$R230" "gunzip -c /tmp/bid-$app.tar.gz | docker load && rm -f /tmp/bid-$app.tar.gz" \
      || abort "$app 加载失败"
  done
fi

# 迁移：一次性容器跑**新镜像**里的 drizzle-kit（迁移 SQL 与 drizzle-kit 都在 api 镜像内，
# WORKDIR=/app/apps/api 故 bun run db:migrate 能解析到本地 .bin）。
# 必须在切流量**之前**：新代码依赖新表结构，先切后迁会有一段时间报错。
echo "=== 应用数据库迁移 ==="
ssh $SSHOPT "$R230" "cd ~/bid/app/deploy && export TAG=latest
$DC run --rm api bun run db:migrate 2>&1 | tail -6" || abort "迁移失败，未切流量"

R2=$(inflight); echo "在途(切流量前): [$R2]"
[ "$R2" = "[]" ] || abort "构建期间出现在途任务，未重启"

echo "=== 切流量 ==="
# **这条必须带 abort**：原来没有，ssh 断链或 up -d 失败时脚本照样往下走，
# 最后打出 ALLDONE——正是「假 ALLDONE」本身（任务 #89 的由来）。
ssh $SSHOPT "$R230" "set -o pipefail; cd ~/bid/app/deploy && export TAG=latest
$DC up -d api agent-api agent-worker web admin || exit 1
sleep 8
docker exec bid-nginx-1 nginx -s reload || $DC restart nginx
sleep 3
docker ps --format '{{.Names}} {{.Status}}' | head -8" || abort "切流量失败（容器可能半新半旧，用 :prev 镜像回滚）"

echo "=== 后置验证：请求发的组件是不是真的换了 ==="
# 只看 ALLDONE 是不够的。--only 传错、某个组件被跳过、镜像没 load 进去，都会表现为
# 「脚本很顺、容器没换」。这里按**容器 Up 时长**核对：刚重建的容器一定是秒/分钟级。
# 这是 2026-08-11 那次 web 被静默跳过之后，我每次发版手工做的那步，固化进脚本。
# 核对清单必须跟着 --only 走：api/agent 无条件构建恒查；web/admin 只在本次要发时才查——
# 2026-08-13 实测 `--only agent` 被固定清单里的 web 判成「组件被跳过」，切完流量、
# 冒烟没跑就 ABORT，一次成功的发版被报成失败。
CHECK="bid-api-1 bid-agent-api-1 bid-agent-worker-1"
wants web && CHECK="$CHECK bid-web-1"
wants admin && CHECK="$CHECK bid-admin-1"
STALE=$(ssh $SSHOPT "$R230" "
for c in $CHECK; do
  up=\$(docker ps --format '{{.Names}}|{{.Status}}' | grep \"^\$c|\" | sed 's/^.*|Up //')
  case \"\$up\" in *second*|*minute*) ;; *) echo \"\$c(\$up)\";; esac
done") || abort "后置验证连不上 230"
if [ -n "$STALE" ]; then
  abort "这些容器没有被重建：$STALE —— 组件被跳过了（多半是 --only 没加引号），别当成发成功"
fi
echo "  本次目标容器（$CHECK）均已重建"

echo "=== 冒烟校验 ==="
# OCR 健康：不静默吞掉——它挂了插图就没有识别文字，审查又会看不出材料在不在
ssh $SSHOPT "$R231" 'curl -s -o /dev/null -w "231 OCR 健康 %{http_code}\n" http://192.168.106.231:8100/health' \
  || echo "WARN: OCR 健康检查失败（插图仍可用，只是没有识别文字）"
# **冒烟必须能判失败**：原来只是把状态码打印出来，502 也照样 ALLDONE，
# 而这几条恰恰是「切完流量到底活没活」的唯一证据。
SMOKE=$(ssh $SSHOPT "$R230" '
fail=""
for pair in "C端首页|http://127.0.0.1/|200" "后台首页|http://127.0.0.1:8081/|200" "api鉴权|http://127.0.0.1/api/projects|401"; do
  IFS="|" read -r name url want <<<"$pair"
  got=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$url")
  echo "$name $got（应 $want）" >&2
  [ "$got" = "$want" ] || fail="$fail $name($got)"
done
echo "$fail"') || abort "冒烟校验连不上 230"
[ -z "$(echo "$SMOKE" | tr -d '[:space:]')" ] || abort "冒烟不通：$SMOKE —— 线上可能已经坏了，用 :prev 镜像回滚"

ssh $SSHOPT "$R230" 'docker image prune -f | tail -1; df -h / | tail -1'
echo "=== ALLDONE $(date) ==="
