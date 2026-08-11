proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "";
proxy_buffering off;
proxy_read_timeout 360s;   # 必须大于 API 侧最长的一次上游等待（PDF 转页图 300s，见 services/files.ts）——否则 nginx 先切断，用户拿到 502 而不是可读的业务错误
