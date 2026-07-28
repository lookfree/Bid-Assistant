#!/usr/bin/env bash
# 自签 TLS 证书（纯 IP 访问的客户验证环境用；生产应改用域名 + 正式/内部 CA 证书）。
# 在目标机执行一次即可，产物落 <仓库根的上级>/certs，**刻意放在 rsync 同步树之外**——
# 私钥不进仓库、也不被发版覆盖。nginx 容器以只读挂载该目录。
#
#   bash deploy/gen-selfsigned-cert.sh              # 默认签 230 的内外网 IP
#   IPS=1.2.3.4,5.6.7.8 bash deploy/gen-selfsigned-cert.sh
#
# 关键点：**SAN 里必须写 IP:**（不是 CN）——现代浏览器只认 SAN，只填 CN 的证书即使
# 手动点了「继续前往」也会被判无效，Chrome 直接拒绝建立安全上下文（滑块验证码依旧不可用）。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(cd .. && pwd)/certs"
IPS="${IPS:-192.168.106.230,117.131.84.2}"
DAYS="${DAYS:-3650}"

mkdir -p "$OUT"
SAN="DNS:localhost,IP:127.0.0.1"
IFS=',' read -ra LIST <<< "$IPS"
for ip in "${LIST[@]}"; do SAN="$SAN,IP:$ip"; done
echo "签发 SAN: $SAN"

openssl req -x509 -nodes -newkey rsa:2048 -days "$DAYS" \
  -keyout "$OUT/bid.key" -out "$OUT/bid.crt" \
  -subj "/C=CN/O=AnGeek/OU=BidAssistant/CN=bid-assistant" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

chmod 600 "$OUT/bid.key"
chmod 644 "$OUT/bid.crt"
echo "已生成："
openssl x509 -in "$OUT/bid.crt" -noout -subject -dates -ext subjectAltName
echo
echo "证书目录：$OUT（compose 以 ../../certs 只读挂载进 nginx）"
echo "提示：自签证书首次访问会有浏览器警告；把 bid.crt 导入客户机器的「受信任的根证书颁发机构」即可消除。"
