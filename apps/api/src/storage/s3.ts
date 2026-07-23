import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { getEnv } from "../config/env"

// 惰性单例：首次使用才读 env、建客户端（import 无副作用，与 getDb/getRedis 一致）。MinIO 用路径风格。
let client: S3Client | undefined
export function getS3(): S3Client {
  if (client) return client
  const env = getEnv()
  client = new S3Client({
    endpoint: env.MINIO_ENDPOINT,
    region: env.MINIO_REGION,
    forcePathStyle: true, // MinIO 需路径风格
    credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
  })
  return client
}

// 预签名专用客户端：SigV4 签名包含 Host，签完改 host 会失效——浏览器可达地址与容器内地址不同时
// （如容器经 SSH 隧道 host.docker.internal 访问、浏览器走 127.0.0.1），必须直接对公开地址签名。
// MINIO_PUBLIC_ENDPOINT 缺省 = MINIO_ENDPOINT（内外一致的部署零变化）。
let presignClient: S3Client | undefined
function getS3Presign(): S3Client {
  const env = getEnv()
  const publicEndpoint = env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT
  if (publicEndpoint === env.MINIO_ENDPOINT) return getS3()
  if (presignClient) return presignClient
  presignClient = new S3Client({
    endpoint: publicEndpoint,
    region: env.MINIO_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
  })
  return presignClient
}

// 优雅关闭：入口在 SIGINT/SIGTERM 时调用，与 closeDb/closeRedis 一致，避免热重载/重启泄漏连接。
export async function closeS3(): Promise<void> {
  if (client) {
    client.destroy()
    client = undefined
  }
  if (presignClient) {
    presignClient.destroy()
    presignClient = undefined
  }
}

export function bucket(): string {
  return getEnv().MINIO_BUCKET
}

/** 同源代理改写（MINIO_PROXY_PREFIX 模式）：绝对预签名 URL → 相对路径。签名对 MINIO_ENDPOINT
 *  的 Host 计算,nginx 在 <prefix>/ 处转发并固定同一 Host,签名仍有效;浏览器走当前入口同源,
 *  公网/内网都可达。未设前缀原样返回（既有部署零变化）。 */
export function toProxyUrl(signedUrl: string): string {
  // 直读 process.env（不走 getEnv 缓存单例）：该键可选、纯字符串,直读让部署改 env 重启即生效,测试也可控
  const prefix = process.env.MINIO_PROXY_PREFIX
  if (!prefix || !prefix.startsWith("/")) return signedUrl
  const u = new URL(signedUrl)
  return `${prefix}${u.pathname}${u.search}`
}

// 预签名 PUT：浏览器凭此直传对象到 MinIO（二进制不经过 App）。
export async function presignPut(key: string, contentType: string, expiresIn: number): Promise<string> {
  return toProxyUrl(
    await getSignedUrl(getS3Presign(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), {
      expiresIn,
    }),
  )
}

// 预签名 GET：浏览器凭此直下；downloadName 设置附件名。
export async function presignGet(key: string, expiresIn: number, downloadName?: string): Promise<string> {
  return toProxyUrl(await getSignedUrl(
    getS3Presign(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      // RFC 5987：非 ASCII/空格文件名必须走 filename*=UTF-8''，否则浏览器不解码引号内的 filename=。
      ResponseContentDisposition: downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        : undefined,
    }),
    { expiresIn },
  ))
}

// HEAD 校验对象是否真上传，取回 size/etag。只把“对象不存在(404)”视为 null；
// 其它(网络/权限/5xx)重抛，避免把基建故障误报成 object_missing。
export async function headObject(key: string): Promise<{ size: number; etag?: string } | null> {
  try {
    const r = await getS3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return { size: Number(r.ContentLength ?? 0), etag: r.ETag?.replaceAll('"', "") }
  } catch (e) {
    // S3 HEAD 对缺失对象返回空体 404，故 httpStatusCode 是权威判据；JS SDK 另会给 name="NotFound"。
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404 || (e as { name?: string }).name === "NotFound") return null
    throw e
  }
}

// 删除对象（超限回收、清理用）。
export async function deleteObject(key: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}
