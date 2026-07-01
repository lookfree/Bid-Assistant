import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
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
      ResponseContentDisposition: downloadName
        ? `attachment; filename="${encodeURIComponent(downloadName)}"`
        : undefined,
    }),
    { expiresIn },
  )
}

// HEAD 校验对象是否真上传，取回 size/etag；不存在返回 null。
export async function headObject(key: string): Promise<{ size: number; etag?: string } | null> {
  try {
    const r = await getS3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return { size: Number(r.ContentLength ?? 0), etag: r.ETag?.replaceAll('"', "") }
  } catch {
    return null
  }
}
