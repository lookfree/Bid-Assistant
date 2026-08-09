client_max_body_size 50m;
# gzip 代理响应：API JSON 未压缩裸传是公网加载慢的主因（content 196KB→~30KB）。
# text/event-stream 不在 types 内 → SSE 进度流不受影响；Next 已压过的静态资源原样透传。
gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_proxied any;
gzip_vary on;
gzip_types application/json application/javascript text/css text/plain image/svg+xml;

# 安全响应头（2026-07-28 起）+ CSP（2026-08-05 补）。
# 原先"CSP 刻意不加"的顾虑是**严格** CSP 会打挂 Next.js 的内联水合脚本——这条仍然成立，
# 故 _sec-site.inc 里的 script-src 保留 'unsafe-inline'，只收紧外发与外部加载方向。
include /etc/nginx/conf.d/_sec-site.inc;

# MinIO 同源代理（2026-07-23 内网访问修复）：预签名 URL 走 /s3/ 相对路径,公网/内网入口都同源可达。
# Host 必须固定为签名时的 MINIO_ENDPOINT host,否则 SigV4 校验失败;上传直传走此路,放大包体并关缓冲。
location /s3/ {
  proxy_pass http://192.168.106.231:9000/;
  proxy_set_header Host "192.168.106.231:9000";
  client_max_body_size 512m;
  proxy_request_buffering off;
}

location /api/   { proxy_pass http://api:8080; include /etc/nginx/conf.d/_proxy.inc; }
location /auth/  { proxy_pass http://api:8080; include /etc/nginx/conf.d/_proxy.inc; }
location /files/ { proxy_pass http://api:8080; include /etc/nginx/conf.d/_proxy.inc; }  # 文件上传/下载(presign)在 /files/*，非 /api/*
# Next 静态产物：文件名带内容哈希，长缓存安全且必要（换版本＝换文件名，不会取到旧的）
location /_next/static/ {
  proxy_pass http://web:3000;
  include /etc/nginx/conf.d/_proxy.inc;
  include /etc/nginx/conf.d/_sec-site.inc;
  proxy_hide_header Cache-Control;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
}

# 页面 HTML / RSC 载荷：Next 对预渲染页只发 s-maxage=31536000（无 max-age），浏览器按启发式缓存
# 会留住旧 HTML，发版后偶发整页还是上一版（实测 /risk 显示旧版两卡入口）。强制每次回源校验。
location /       {
  proxy_pass http://web:3000;
  include /etc/nginx/conf.d/_proxy.inc;
  include /etc/nginx/conf.d/_sec-site.inc;
  proxy_hide_header Cache-Control;
  add_header Cache-Control "no-store, must-revalidate" always;
}
