# spec006 · 文件直传（MinIO/S3 预签名） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 S3 预签名 URL 实现浏览器**直传/直下** MinIO（bucket `bidsaas`）：`project_files` 元数据表 + 文件服务（presign 上传/确认/下载）+ 鉴权保护的 `/files/*` 接口，并把 C 端 `/upload` 原型接上真实直传。

**Architecture:** App 只签发预签名 URL、记元数据，**文件二进制不经过 App**（直传到 MinIO，省 App 带宽，呼应架构 §13）。统一用 AWS S3 SDK v3 指向 MinIO（`forcePathStyle`）。上传三段：presign → 浏览器 PUT 到 MinIO → confirm（HEAD 校验落 `uploaded`）。

**Tech Stack:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`（纯 JS）、Drizzle、Hono（鉴权中间件 spec004）、`bun:test`、`mc`（配 MinIO CORS）。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 对象存储抽象 = S3 API；实现 = MinIO；代码只用 S3 SDK + 预签名（不绑厂商，§14）。
- 连接从 env 读（`MINIO_*`，已在 `.env.bidsaas.local`）；bucket `bidsaas`（已建）。
- `/files/*` 全部 `authMiddleware` 保护；文件属 `userId`，下载只能本人（仅本人可见，§9）。
- 预签名短时效（默认 600s）；上传大小上限可配。
- 集成测试连真 MinIO（bidsaas）做真实 PUT/GET 往返，自清理对象与行。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── src/
│   ├── config/env.ts                 # 改：补 MINIO_* / FILE_* 
│   ├── storage/s3.ts                 # 新：S3Client(指向 MinIO) + 预签名封装
│   ├── db/schema/project-files.ts    # 新：project_files + file_status 枚举
│   ├── db/schema/index.ts            # 改：汇出
│   ├── services/files.ts             # 新：presignUpload/confirmUpload/presignDownload
│   ├── routes/files.ts               # 新：/files/presign-upload、/:id/complete、/:id/download-url
│   ├── app.ts                        # 改：挂载 /files（鉴权）
│   └── index.ts                      # 改：装配 files deps
└── test/
    ├── services/files.test.ts        # 新：真 MinIO 往返
    └── routes/files.test.ts          # 新：鉴权 + 契约
apps/web/
└── app/(tool)/upload/page.tsx        # 改：mock → 真实直传
```

---

## Interfaces（本 spec 对外产出）

- Produces：
  - `project_files` 表；`ProjectFile = typeof projectFiles.$inferSelect`。
  - 文件服务（注入 `db`/`s3`）：
    - `presignUpload(input: { userId; filename; contentType; size }): Promise<{ fileId; key; uploadUrl }>`
    - `confirmUpload(fileId: string, userId: string): Promise<ProjectFile>`（HEAD 校验存在，落 `uploaded`+size+etag）
    - `presignDownload(fileId: string, userId: string): Promise<{ url: string; filename: string }>`
  - HTTP（均 Bearer）：
    - `POST /files/presign-upload` body `{ filename, contentType, size }` → `200 { fileId, key, uploadUrl }` / `400 { error:"file_too_large" | "invalid_input" }`
    - `POST /files/:id/complete` → `200 { file }` / `404` / `409 { error:"object_missing" }`
    - `GET /files/:id/download-url` → `200 { url, filename }` / `404`

---

## Task 1: env + S3 客户端（指向 MinIO）

**Files:**
- Modify: `apps/api/src/config/env.ts`、`apps/api/package.json`
- Create: `apps/api/src/storage/s3.ts`、`apps/api/test/storage/s3.smoke.test.ts`

- [ ] **Step 1: 开分支 + 装 SDK**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec006-file-upload
cd apps/api && bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: env schema 追加**

```ts
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string().default("bidsaas"),
  MINIO_REGION: z.string().default("us-east-1"),
  FILE_MAX_SIZE_MB: z.coerce.number().int().positive().default(50),
  FILE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
```

- [ ] **Step 2.5: 同步更新 spec002 的 `env.test.ts`（必填 env 回归）**

新增的 `MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY` 是**必填**（无 default），会打挂 spec002 `apps/api/test/env.test.ts` 里「解析合法 env」那条只传 `DATABASE_URL` 的用例。**不要把 MINIO_* 改 optional**，改测试：给该用例的最小合法集补全 MINIO_* 占位值。

```ts
// apps/api/test/env.test.ts —— "parses valid env with defaults" 分支补 MINIO_* 占位
const env = parseEnv({
  DATABASE_URL: "postgresql://u:p@h:5432/d",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "test-access-key",
  MINIO_SECRET_KEY: "test-secret-key",
})
```

Run: `cd apps/api && bun test test/env.test.ts`
Expected: PASS（含新必填字段后 env.test 仍全绿）。

- [ ] **Step 3: 写 `apps/api/src/storage/s3.ts`**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "../config/env"

export const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: env.MINIO_REGION,
  forcePathStyle: true, // MinIO 需路径风格
  credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
})

export const BUCKET = env.MINIO_BUCKET

export function presignPut(key: string, contentType: string, expiresIn: number) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn })
}

export function presignGet(key: string, expiresIn: number, downloadName?: string) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${encodeURIComponent(downloadName)}"` : undefined,
    }),
    { expiresIn },
  )
}

export async function headObject(key: string): Promise<{ size: number; etag?: string } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return { size: Number(r.ContentLength ?? 0), etag: r.ETag?.replaceAll('"', "") }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 写 S3 往返冒烟 `apps/api/test/storage/s3.smoke.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { presignPut, presignGet, headObject, BUCKET } from "../../src/storage/s3"

describe("s3 (MinIO bidsaas)", () => {
  it("presign PUT -> 上传 -> HEAD -> presign GET -> 下载一致", async () => {
    const key = `smoke/${Date.now()}.txt`
    const body = "hello-minio"
    const putUrl = await presignPut(key, "text/plain", 120)
    const put = await fetch(putUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body })
    expect(put.ok).toBe(true)

    const head = await headObject(key)
    expect(head?.size).toBe(body.length)

    const getUrl = await presignGet(key, 120)
    const got = await fetch(getUrl)
    expect(await got.text()).toBe(body)

    // 清理
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3")
    const { s3 } = await import("../../src/storage/s3")
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  })
})
```

- [ ] **Step 5: 运行冒烟（真 MinIO）**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/storage/s3.smoke.test.ts`
Expected: PASS（往返一致）。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/config/env.ts apps/api/src/storage apps/api/test/storage apps/api/package.json
git commit -m "feat(spec006): S3 客户端指向 MinIO + 预签名封装 + 往返冒烟

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: project_files schema + 迁移

**Files:**
- Create: `apps/api/src/db/schema/project-files.ts`
- Modify: `apps/api/src/db/schema/index.ts`、`apps/api/drizzle/*`

- [ ] **Step 1: 写 `apps/api/src/db/schema/project-files.ts`**

```ts
import { pgTable, uuid, text, bigint, timestamp, pgEnum, index } from "drizzle-orm/pg-core"
import { users } from "./users"

export const fileStatus = pgEnum("file_status", ["pending", "uploaded"])

export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"), // 项目状态机 Phase 2，先留空
    bucket: text("bucket").notNull(),
    key: text("key").notNull().unique(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    status: fileStatus("status").notNull().default("pending"),
    etag: text("etag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byUser: index("project_files_user_id_idx").on(t.userId) }),
)

export type ProjectFile = typeof projectFiles.$inferSelect
```

- [ ] **Step 2: `schema/index.ts` 加一行汇出**

```ts
export * from "./project-files"
```

- [ ] **Step 3: 生成并应用迁移**

Run: `cd apps/api && bun run db:generate && bun run db:migrate`
Expected: 新增 `file_status` 枚举 + `project_files` 表（迁移到 bidsaas）。

- [ ] **Step 4: 验证表存在 + 提交**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local -e "import('./src/db/client').then(async m=>{const {sql}=await import('drizzle-orm');console.log(await m.db.execute(sql\`select to_regclass('public.project_files')\`))})"`
Expected: 非 null。

```bash
git add apps/api/src/db apps/api/drizzle
git commit -m "feat(spec006): project_files schema + 迁移到 bidsaas

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 文件服务（presign/confirm/download）+ 真 MinIO 集成测试

**Files:**
- Create: `apps/api/src/services/files.ts`、`apps/api/test/services/files.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/services/files.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { presignUpload, confirmUpload, presignDownload } from "../../src/services/files"
import { createUserWithIdentity } from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users, projectFiles } from "../../src/db/schema"
import { eq } from "drizzle-orm"
import { s3, BUCKET } from "../../src/storage/s3"

let userId = ""
const phone = `+8613${Date.now().toString().slice(-9)}`

beforeAll(async () => {
  userId = (await createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })).id
})
afterAll(async () => {
  const rows = await db.select().from(projectFiles).where(eq(projectFiles.userId, userId))
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
  for (const r of rows) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r.key })).catch(() => {})
  await db.delete(users).where(eq(users.id, userId)) // 级联删 project_files
})

describe("files service", () => {
  it("presign -> PUT -> confirm 落 uploaded -> download 取回一致", async () => {
    const body = "招标文件示例"
    const { fileId, uploadUrl } = await presignUpload({
      userId, filename: "tender.txt", contentType: "text/plain", size: Buffer.byteLength(body),
    })
    await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body })

    const file = await confirmUpload(fileId, userId)
    expect(file.status).toBe("uploaded")
    expect(file.size).toBe(Buffer.byteLength(body))

    const { url, filename } = await presignDownload(fileId, userId)
    expect(filename).toBe("tender.txt")
    expect(await (await fetch(url)).text()).toBe(body)
  })

  it("别人无法下载我的文件", async () => {
    const { fileId } = await presignUpload({ userId, filename: "a.txt", contentType: "text/plain", size: 1 })
    await expect(presignDownload(fileId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/services/files.test.ts`
Expected: FAIL（`../../src/services/files` 不存在）。

- [ ] **Step 3: 写 `apps/api/src/services/files.ts`**

```ts
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "../db/client"
import { projectFiles, type ProjectFile } from "../db/schema"
import { BUCKET, presignPut, presignGet, headObject } from "../storage/s3"
import { env } from "../config/env"

function sanitize(name: string): string {
  return name.replace(/[^\w.\-一-龥]/g, "_").slice(0, 120)
}

export async function presignUpload(input: {
  userId: string
  filename: string
  contentType: string
  size: number
}): Promise<{ fileId: string; key: string; uploadUrl: string }> {
  if (input.size > env.FILE_MAX_SIZE_MB * 1024 * 1024) throw new Error("file_too_large")
  const key = `uploads/${input.userId}/${randomUUID()}/${sanitize(input.filename)}`
  const [row] = await db
    .insert(projectFiles)
    .values({
      userId: input.userId,
      bucket: BUCKET,
      key,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      status: "pending",
    })
    .returning()
  const uploadUrl = await presignPut(key, input.contentType, env.FILE_PRESIGN_TTL_SECONDS)
  return { fileId: row!.id, key, uploadUrl }
}

async function ownFile(fileId: string, userId: string): Promise<ProjectFile> {
  const [row] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.id, fileId), eq(projectFiles.userId, userId)))
    .limit(1)
  if (!row) throw new Error("not_found")
  return row
}

export async function confirmUpload(fileId: string, userId: string): Promise<ProjectFile> {
  const file = await ownFile(fileId, userId)
  const head = await headObject(file.key)
  if (!head) throw new Error("object_missing")
  const [updated] = await db
    .update(projectFiles)
    .set({ status: "uploaded", size: head.size, etag: head.etag })
    .where(eq(projectFiles.id, fileId))
    .returning()
  return updated!
}

export async function presignDownload(fileId: string, userId: string): Promise<{ url: string; filename: string }> {
  const file = await ownFile(fileId, userId)
  const url = await presignGet(file.key, env.FILE_PRESIGN_TTL_SECONDS, file.filename)
  return { url, filename: file.filename }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/services/files.test.ts`
Expected: PASS（2 项），自清理。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/services/files.ts apps/api/test/services/files.test.ts
git commit -m "feat(spec006): 文件服务 presign/confirm/download + 真 MinIO 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: /files 路由（鉴权）+ 集成测试

**Files:**
- Create: `apps/api/src/routes/files.ts`、`apps/api/test/routes/files.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: 写 `apps/api/src/routes/files.ts`**

```ts
import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { presignUpload, confirmUpload, presignDownload } from "../services/files"
import type { User } from "../db/schema"

const presignSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1),
  size: z.coerce.number().int().nonnegative(),
})

export function fileRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.post("/presign-upload", async (c) => {
    const body = presignSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    try {
      const out = await presignUpload({ userId: c.get("user").id, ...body.data })
      return c.json(out)
    } catch (e) {
      if ((e as Error).message === "file_too_large") return c.json({ error: "file_too_large" }, 400)
      throw e
    }
  })

  r.post("/:id/complete", async (c) => {
    try {
      const file = await confirmUpload(c.req.param("id"), c.get("user").id)
      return c.json({ file })
    } catch (e) {
      const m = (e as Error).message
      if (m === "not_found") return c.json({ error: "not_found" }, 404)
      if (m === "object_missing") return c.json({ error: "object_missing" }, 409)
      throw e
    }
  })

  r.get("/:id/download-url", async (c) => {
    try {
      return c.json(await presignDownload(c.req.param("id"), c.get("user").id))
    } catch (e) {
      if ((e as Error).message === "not_found") return c.json({ error: "not_found" }, 404)
      throw e
    }
  })

  return r
}
```

- [ ] **Step 2: `app.ts` 挂载 /files**

在 `createApp` 内加：`app.route("/files", fileRoutes())`（import `fileRoutes`）。`/files/*` 自带鉴权，无需额外 deps。

- [ ] **Step 3: 写路由测试 `apps/api/test/routes/files.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createApp } from "../../src/app"
import { loginWithPhone } from "../../src/services/auth"
import { db } from "../../src/db/client"
import { users, projectFiles } from "../../src/db/schema"
import { s3, BUCKET } from "../../src/storage/s3"
import { eq } from "drizzle-orm"

const app = createApp({ pingDb: async () => true })
const phone = `+8613${Date.now().toString().slice(-9)}`
let token = ""
let userId = ""

beforeAll(async () => {
  const r = await loginWithPhone(phone, { agreedToTerms: true }, 30)
  token = r.token; userId = r.user.id
})
afterAll(async () => {
  const rows = await db.select().from(projectFiles).where(eq(projectFiles.userId, userId))
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
  for (const r of rows) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r.key })).catch(() => {})
  await db.delete(users).where(eq(users.id, userId))
})

const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

describe("/files", () => {
  it("未鉴权 -> 401", async () => {
    const res = await app.request("/files/presign-upload", { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })

  it("presign -> PUT -> complete -> download-url 全链路", async () => {
    const body = "tender-bytes"
    const pre = await app.request("/files/presign-upload", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ filename: "t.txt", contentType: "text/plain", size: body.length }),
    })
    expect(pre.status).toBe(200)
    const { fileId, uploadUrl } = await pre.json()
    await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body })

    const done = await app.request(`/files/${fileId}/complete`, { method: "POST", headers: auth() })
    expect(done.status).toBe(200)
    expect((await done.json()).file.status).toBe("uploaded")

    const dl = await app.request(`/files/${fileId}/download-url`, { headers: auth() })
    const { url } = await dl.json()
    expect(await (await fetch(url)).text()).toBe(body)
  })
})
```

- [ ] **Step 4: 运行 + 提交**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/routes/files.test.ts`
Expected: PASS（2 项）。

```bash
git add apps/api/src/routes/files.ts apps/api/src/app.ts apps/api/test/routes/files.test.ts
git commit -m "feat(spec006): /files 路由(鉴权) + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MinIO CORS + 前端 /upload 直传 + 合并

**Files:**
- Modify: `apps/web/app/(tool)/upload/page.tsx`

- [ ] **Step 1: 给 MinIO bidsaas 桶配 CORS（允许浏览器直传）**

浏览器从 web 源直接 PUT 到 MinIO 需 CORS。用服务器上的 `mc`（spec 前置：MinIO 在 `60.205.160.74`）设置：

```bash
ssh root@60.205.160.74 'cat > /tmp/cors.json <<JSON
[ { "AllowedOrigin": ["http://localhost:3000","http://localhost:3001"],
    "AllowedMethod": ["PUT","GET","HEAD"],
    "AllowedHeader": ["*"], "ExposeHeader": ["ETag"], "MaxAgeSeconds": 3000 } ]
JSON
/usr/local/bin/mc cors set localminio/bidsaas /tmp/cors.json 2>/dev/null || /usr/local/bin/mc admin config ...'
```
> mc 版本不同命令略异：新版 `mc cors set <alias>/<bucket> <file>`。生产再加正式域名。验证：`mc cors get localminio/bidsaas`。

- [ ] **Step 2: 接入 `apps/web/app/(tool)/upload/page.tsx`（替换 mock 直传）**

读现有 `/upload` 页，把"选择文件→上传"的 mock 换成三段直传（保留进度/列表 UI）。核心逻辑：

```tsx
import { api } from "@/lib/api"

async function uploadFile(file: File, onDone: (fileId: string) => void, onError: (m: string) => void) {
  try {
    const { fileId, uploadUrl } = await api.request<{ fileId: string; uploadUrl: string }>("/files/presign-upload", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream", size: file.size }),
    })
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file })
    if (!put.ok) throw new Error("upload failed")
    await api.request(`/files/${fileId}/complete`, { method: "POST" })
    onDone(fileId)
  } catch {
    onError("上传失败，请重试")
  }
}
```

- [ ] **Step 3: 端到端冒烟（浏览器）**

```bash
cd apps/api && bun run api   # :8080
cd apps/web && bun run web   # :3000
```
登录后到 `/upload` 选一个文件 → 直传到 MinIO → 列表显示成功；MinIO 控制台（`http://60.205.160.74:9001`）`bidsaas` 桶 `uploads/<userId>/...` 可见该对象。

- [ ] **Step 4: 全量校验 + 合并**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test && bun run typecheck` 与 `cd apps/web && bun run build`
Expected: 全绿。

```bash
git add "apps/web/app/(tool)/upload/page.tsx"
git commit -m "feat(spec006): 前端 /upload 接真实 MinIO 直传"
git checkout main
git merge --no-ff phase0/spec006-file-upload -m "merge spec006: 文件直传 MinIO"
git push origin main
```

---

## 验收清单（spec006 完成判据）

- [ ] S3 客户端指向 MinIO（forcePathStyle），presign PUT/GET/HEAD 真往返通过。
- [ ] MINIO_* 必填后已同步更新 spec002 `env.test.ts` 最小合法集；`bun test` 含 env.test 全绿。
- [ ] `project_files` 迁移到 bidsaas；上传 pending→uploaded（size/etag 落库）。
- [ ] `/files/presign-upload`、`/:id/complete`、`/:id/download-url` 全 Bearer 保护；非本人文件 404/拒绝。
- [ ] 文件二进制**不经过 App**（直传/直下 MinIO）；超限返回 `file_too_large`。
- [ ] MinIO `bidsaas` 桶配好 CORS，浏览器直传成功；`/upload` 端到端可用。
- [ ] `bun test` + `typecheck` + web `build` 全绿。
