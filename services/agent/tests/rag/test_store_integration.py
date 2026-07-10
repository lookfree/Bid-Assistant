"""spec316 A1: 真库往返回归测——证明 Jsonb + vector 绑定 + cosine 检索端到端可用。

这是 Critical 缺陷（bare dict 无法 adapt 成 jsonb）的回归护栏：mock 测试看不见真实绑定，
只有打真库才暴露。DB 不可达时（本机无网络/CI 无 DB）跳过；mbp 全量套件会真跑（Task C）。
"""
import uuid

import pytest

from agent.db import get_pool, ping
from agent.rag import store
from agent.rag.schema import setup_rag

pytestmark = pytest.mark.skipif(not ping(), reason="需可达的 Postgres（含 pgvector）")


def test_upsert_search_roundtrip_with_jsonb_meta_and_vector():
    pool = get_pool()
    setup_rag(pool)
    user_id = str(uuid.uuid4())
    source_id = f"itest-{uuid.uuid4()}"
    try:
        chunks = ["资质证明：建筑工程施工总承包壹级。", "业绩：近三年市政道路十七项。"]
        embeddings = [[0.1] * 1024, [0.2] * 1024]
        metas = [{"category": "qualification", "title": "资质"}, {"category": "record"}]
        n = store.upsert(pool, user_id, "library", source_id, chunks, embeddings, metas)
        assert n == 2

        rows = store.search(pool, user_id, "library", [0.1] * 1024, top_k=5)
        assert len(rows) == 2
        first = rows[0]
        assert set(first) == {"text", "meta", "score"}
        assert isinstance(first["text"], str) and first["text"]
        assert isinstance(first["meta"], dict)          # meta 作为 dict 原样回来（Jsonb 往返）
        assert isinstance(first["score"], float)
        # 最近邻应是与查询向量一致的那块（cosine 距离 0 → score 1）
        top = next(r for r in rows if r["text"] == chunks[0])
        assert top["meta"].get("category") == "qualification"
        assert top["score"] == pytest.approx(1.0, abs=1e-4)
    finally:
        store.delete(pool, user_id, "library", source_id)
        with pool.connection() as conn:
            left = conn.execute(
                "select count(*) from agent.rag_chunks where user_id=%s", (user_id,)
            ).fetchone()[0]
        assert left == 0
