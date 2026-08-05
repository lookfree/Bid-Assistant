# 安全响应头（2026-07-28 安全测试报告项）。凡是自己加了 add_header 的 location 都要 include 本片段，
# 否则该 location 会丢掉 server 层继承的全部 add_header（nginx add_header 的继承规则）。
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options SAMEORIGIN always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
