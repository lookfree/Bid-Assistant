# OCR 与嵌入服务 · 换机清单

把 OCR / 嵌入换到别的机器时照着走。**结论先说：改两个环境变量就够，不用动代码或镜像**——
但有两个坑会让改动「看起来成功、实际静默失效」，先看第 3 节。

## 1. 现状（2026-08-12 实测）

两个服务都跑在**数据机 231**（`deploy/data/docker-compose.data.yml`），和 PG/Redis/MinIO 同机；
应用机 230 只跑 api / agent / web / admin / nginx。

| | OCR | 嵌入（BGE-M3） |
|---|---|---|
| 容器 / 镜像 | `ocr` / `bid-ocr`（本地构建自 `services/ocr`） | `bge-embed` / `bid-bge-embed` |
| 监听 | `192.168.106.231:8100` → 容器 8000 | `192.168.106.231:8200` → 容器 8000 |
| 资源限额 | 3 核 / 3G，`OCR_THREADS=2` | 4 核 / 8G（实测常驻 **7.2G**） |
| 模型 | ONNXRuntime，镜像内置 | 外部卷 `bid_bge_models`，权重 4.4G |
| 健康检查 | `GET /health` | `GET /health` |

嵌入服务 2026-08-10 从应用机迁来（它常驻 7.2G，压在 230 上和 api/agent/web 抢内存）。
230 上因此留着一个孤儿容器 `bid-bge-embed-1`，每次 compose 都会警告 `Found orphan containers`——
那是迁移残留，**不服务任何流量**。

## 2. 换机要改什么

`~/bid/app/deploy/.env.deploy.local`（在 230 上）两行：

```sh
RAG_EMBED_ENDPOINT=http://<新机>:<端口>/v1/embeddings   # 注意 RAG_ 前缀，不是 EMBED_ENDPOINT
OCR_BASE_URL=http://<新机>:<端口>                        # api 与 agent 共用同一个地址
```

改完必须**重建容器**（`env_file` 是启动时读的，改文件不重建不生效）：

```sh
cd ~/bid/app/deploy
docker compose -f docker-compose.cust.yml --env-file .env.deploy.local up -d api agent-api agent-worker
```

`OCR_BASE_URL` 一处改、两处生效：api 用于资料库图片 OCR，agent 用于审查扫描页与正文插图。

## 3. 两个坑

### 坑一：嵌入模型必须仍是 1024 维，否则静默毁掉检索

`services/agent/src/agent/rag/schema.py:18` 写死 `vector(1024)`，那是 BGE-M3 的维度。

- 维度不同 → 写入报错。**这是好结果**，当场就发现。
- **维度恰好也是 1024、但模型不同 → 不报错**，新旧向量落在两个语义空间里，检索结果安静地变成垃圾。

所以换嵌入服务的安全前提只有两个：**仍是 BGE-M3**，或者**接受清空向量表重建索引**。

### 坑二：别改 compose 用 `environment:` 透传

`docker-compose.cust.yml` 里两个 agent 服务都用 `env_file: [.env.deploy.local]`，**不要**改成
`environment: OCR_BASE_URL: "${OCR_BASE_URL}"`。`environment` 覆盖 `env_file`，一旦哪次 compose
少带 `--env-file`，变量就被插成空串——而空值的语义是「这套环境没部署 OCR，整段跳过」
（配置驱动降级）。结果是 OCR 被静默关掉，扫描件识别不干活了，**没有任何报错**。

同类还有一处：agent 的 `RAG_EMBED_ENDPOINT` 有默认值
`http://host.docker.internal:18080/v1/embeddings`（本地开发用）。生产不显式配就会连这个不存在的
地址，而 RAG 是 best-effort、失败只打 warning，**同样不报错**，表现为检索恒空。

## 4. 别忘了的运维项

- **两个服务都没有鉴权**，现在靠端口绑内网口保护（`192.168.106.231:8100:8000` 而不是
  `0.0.0.0:8100:8000`）。新机同样要绑内网口或加防火墙，**绝不能裸奔在公网**。
- **时延**：嵌入 CPU 推理实测 ~11s/批，客户端超时 60s（`EMBED_TIMEOUT_S`）、并发 8 路
  （`EMBED_CONCURRENCY`）；OCR 单页 20s 上限（`_PAGE_TIMEOUT_S`）、整轮 20 分钟总帽（`_TOTAL_BUDGET_S`）。
  跨公网这些值大概率不够，要一起调。
- **内存**：嵌入常驻 7.2G，新机至少留 8G 给它。

## 5. 换完怎么验

在 **230 上**执行（要验的是应用机到新机这条路，不是你本地到新机）：

```sh
for p in <OCR端口> <嵌入端口>; do
  (echo > /dev/tcp/<新机>/$p) 2>/dev/null && echo "$p 通" || echo "$p 不通"
done
curl -s -m 5 -o /dev/null -w 'OCR   %{http_code}\n' http://<新机>:<OCR端口>/health
curl -s -m 5 -o /dev/null -w 'EMBED %{http_code}\n' http://<新机>:<嵌入端口>/health
```

两个都 200 之后，再走一遍**真实链路**——端口通不等于功能对：

1. 资料库上传一张证照图片，看条目里出不出 `ocrText`；
2. 上传一份扫描版 PDF 做废标审查，看识别进度条动不动、结论里有没有扫描页内容；
3. 资料库随便检索一次，看正文步的简报里【参考资料】段是否非空。

第 3 步专门验嵌入：它失败是静默的，只看健康检查发现不了。
