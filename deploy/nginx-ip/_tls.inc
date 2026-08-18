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

# HSTS 暂不加：现在 http://117.131.84.2:18080 仍是主入口，HSTS 会把同一浏览器对该域名的
# http 访问全部强制跳 https。等 443 实测通、且 18080 退役后再补 Strict-Transport-Security。
