import { describe, it, expect, setDefaultTimeout } from "bun:test"
import { DeleteObjectCommand } from "@aws-sdk/client-s3"
import { getS3, bucket, presignPut, presignGet, headObject } from "../../src/storage/s3"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 MinIO

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

    await getS3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  })
})
