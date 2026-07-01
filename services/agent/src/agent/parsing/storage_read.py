from __future__ import annotations

import asyncio

import boto3

from agent.config import settings

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=settings.minio_endpoint,
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            region_name=settings.minio_region,
        )
    return _client


def read_bytes(key: str) -> bytes:
    obj = _s3().get_object(Bucket=settings.minio_bucket, Key=key)
    return obj["Body"].read()


def _put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    """仅测试/工具用：上传字节（同步）。"""
    _s3().put_object(Bucket=settings.minio_bucket, Key=key, Body=data, ContentType=content_type)


def _delete(key: str) -> None:
    _s3().delete_object(Bucket=settings.minio_bucket, Key=key)


class _Storage:
    """异步存储 facade（boto3 同步，用 to_thread 包成 async）。
    供 Phase 2 渲染产物回写用：述标 .pptx（spec205）、完整标书 .docx（spec206）。"""
    async def read_bytes(self, key: str) -> bytes:
        return await asyncio.to_thread(read_bytes, key)

    async def put_bytes(self, key: str, data: bytes,
                        content_type: str = "application/octet-stream") -> None:
        await asyncio.to_thread(_put_bytes, key, data, content_type)


storage = _Storage()   # 单例：from agent.parsing.storage_read import storage
