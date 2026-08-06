# 数据机（231）compose

PostgreSQL16+pgvector / Redis7 / MinIO / OCR。文件此前只存在于 231 上，现收进仓库。

## 发版脚本只会动 `ocr`

`deploy/deploy-cust.sh` 同步本文件到 231 后**只执行 `up -d ocr`**。数据层三个服务一律不碰：

- 它们是客户的活数据层，重启一次全站停；
- 本文件给它们补的资源限额**改变了容器 spec**，`up -d` 会**重建**容器，不是热更新。

## 要让数据层的资源限额生效时（择时手工执行）

重建会有秒级到十几秒的中断，务必先确认没有在途任务（`project_steps.status='running'` 为空）。

```bash
ssh angeek@192.168.106.231
cd ~/bid/data
docker compose --env-file .env.data up -d postgres redis minio
docker inspect bid-data-postgres-1 --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
```

## `--env-file .env.data` 不能省

`${POSTGRES_PASSWORD}`、`${REDIS_PASSWORD}`、`${MINIO_ROOT_USER}` 这些是 **Compose 插值**，
来源是 shell 环境或项目目录下的 `.env`——**不是 `env_file:`**（`env_file` 只把变量注进容器，
不参与 compose 文件本身的插值）。231 上只有 `.env.data`、没有 `.env`，因此不带 `--env-file`
就会全部插成空串：数据库以空密码重建、Redis 以 `--requirepass ""` 启动（等于在内网端口上关掉鉴权）。

## 现状（2026-08-06 实测）

12C/32G，实测已用 0G / 可用 29G，数据库 878 MB——OCR 放在这台是因为应用机 230 已扛着
全部应用服务外加 bge-embed（实测常驻 7.24 GiB）。

**待办**：物理盘 3TB，LVM 仅分了 100G。标书文件都落 MinIO，写满即上传失败，需在线扩 LV。
