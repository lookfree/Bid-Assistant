# TLS 参数（2026-08-18 上域名 www.zhiqiyuan.cn，WoTrus DV 证书）。
# 证书放 ~/bid/certs（compose 以 ../certs 只读挂载），**刻意在发版同步树之外**：
# 私钥不进仓库、也不被 git archive 覆盖。到期日 2027-03-04，换证只需替换这两个文件 + reload。
ssl_certificate     /etc/nginx/certs/zhiqiyuan.pem;   # 含中间证书的完整链（4 段），缺链会让部分安卓机报不受信任
ssl_certificate_key /etc/nginx/certs/zhiqiyuan.key;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;                        # TLS1.3 时代由客户端选更优
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;

# HSTS 不在这里发，在 _sec-site.inc 里：本文件只在 server 层 include，而 `location /`
# 与 `/_next/static/` 各自带了 add_header —— 它们会丢掉 server 层继承的全部头，HTML 响应
# （最该带 HSTS 的那个）恰好就落在其中。
