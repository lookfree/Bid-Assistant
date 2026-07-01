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

// 优雅关闭：入口在 SIGINT/SIGTERM 时调用，与 closeDb/closeRedis 一致，避免热重载/重启泄漏连接。
export async function closeS3(): Promise<void> {
  if (client) {
    client.destroy()
    client = undefined
  }
}

export function bucket(): string {
  return getEnv().MINIO_BUCKET
}

// 预签名 PUT：浏览器凭此直传对象到 MinIO（二进制不经过 App）。
export function presignPut(key: string, contentType: string, expiresIn: number): Promise<string> {
  return getSignedUrl(getS3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), {
    expiresIn,
  })
}

// 预签名 GET：浏览器凭此直下；downloadName 设置附件名。
export function presignGet(key: string, expiresIn: number, downloadName?: string): Promise<string> {
  return getSignedUrl(
    getS3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      // RFC 5987：非 ASCII/空格文件名必须走 filename*=UTF-8''，否则浏览器不解码引号内的 filename=。
      ResponseContentDisposition: downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        : undefined,
    }),
    { expiresIn },
  )
}

// HEAD 校验对象是否真上传，取回 size/etag。只把“对象不存在(404)”视为 null；
// 其它(网络/权限/5xx)重抛，避免把基建故障误报成 object_missing。
export async function headObject(key: string): Promise<{ size: number; etag?: string } | null> {
  try {
    const r = await getS3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return { size: Number(r.ContentLength ?? 0), etag: r.ETag?.replaceAll('"', "") }
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const name = (e as { name?: string }).name
    if (status === 404 || name === "NotFound" || name === "NotFoundException") return null
    throw e
  }
}

// 删除对象（超限回收、清理用）。
export async function deleteObject(key: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}
