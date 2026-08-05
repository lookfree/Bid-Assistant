client_max_body_size 50m;
gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_proxied any;
gzip_vary on;
gzip_types application/json application/javascript text/css text/plain image/svg+xml;

# 安全响应头（2026-07-28 起）+ CSP（2026-08-05 补，见 _sec-admin.inc）。
include /etc/nginx/conf.d/_sec-admin.inc;

location /admin-api/ { proxy_pass http://api:8080;   include /etc/nginx/conf.d/_proxy.inc; }
# 与 C 端同因（见 _site.inc）：Next 预渲染页只发 s-maxage，浏览器启发式缓存会留住旧 HTML，
# 发版后偶发整页还是上一版。静态产物文件名带哈希，仍长缓存。
location /_next/static/ {
  proxy_pass http://admin:3001;
  include /etc/nginx/conf.d/_proxy.inc;
  include /etc/nginx/conf.d/_sec-admin.inc;
  proxy_hide_header Cache-Control;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
}

location /           {
  proxy_pass http://admin:3001;
  include /etc/nginx/conf.d/_proxy.inc;
  include /etc/nginx/conf.d/_sec-admin.inc;
  proxy_hide_header Cache-Control;
  add_header Cache-Control "no-store, must-revalidate" always;
}
