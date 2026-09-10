"""
知识召回 + 入口闸门（产品文档 §6.3 的 Confidence Check）。

只召回 Knowledge —— 观点/方法论/样本各只有几条，全量进 prompt 比检索更准
也更便宜（见 specs/004-m3-chat/spec.md §3）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select

from app.db.session import tenant_conn
from app import obs
from app.db.tables import chunks
from app.pipeline import rerank as rr
from app.pipeline.config import RERANK_MIN_SCORE
from app.pipeline.embed import get_provider as get_embedder

log = logging.getLogger(__name__)

# 先用向量粗筛这么多，再交给 rerank 精排
VECTOR_TOP_K = 30
# 精排后最多喂给模型几条
FINAL_TOP_K = 6


@dataclass
class Hit:
    chunk_id: UUID
    content: str
    source: str
    #: 入口闸门实际比较的值 = rerank × chunk.confidence
    score: float
    #: 裸 rerank 分数，未降权。评测和排障要看它，闸门不看它
    rerank: float
    #: 切片自身的可信度。命中注入特征的切片在入库时被降到 0.2
    confidence: float


async def retrieve_scored(tenant_id: UUID, expert_id: UUID, question: str) -> list[Hit]:
    """
    召回并打分，**不过闸门**。

    存在的理由是阈值校准（M6）：把闸门前的完整排序和分数拿出来，
    就能用一次召回的开销扫完整条阈值曲线 —— 而不是每换一个阈值
    重跑一遍 embedding + rerank。

    `retrieve()` 就是它加一次过滤，两者共用同一条代码路径 ——
    否则校准出来的阈值和线上实际用的分数会悄悄对不上。
    """
    embedder = get_embedder()
    (qvec,) = await embedder.embed([question])

    async with tenant_conn(tenant_id) as conn:
        rows = (
            await conn.execute(
                select(
                    chunks.c.id, chunks.c.content, chunks.c.source, chunks.c.confidence
                )
                .where(chunks.c.expert_id == expert_id)
                .order_by(chunks.c.embedding.cosine_distance(qvec))
                .limit(VECTOR_TOP_K)
            )
        ).fetchall()

    if not rows:
        return []

    ranked = await rr.get_provider().rank(question, [r.content for r in rows])

    out: list[Hit] = []
    for idx, score in ranked:
        row = rows[idx]
        # 切片自身的 confidence 参与打分：命中注入特征的切片在入库时被降到 0.2，
        # 于是它需要 5 倍的相关度才挤得进来。这一乘把「防注入」和「防幻觉」
        # 合并成了同一个机制 —— 不需要为投毒内容单独写一条规则。
        conf = row.confidence if row.confidence is not None else 1.0
        out.append(
            Hit(
                chunk_id=row.id,
                content=row.content,
                source=row.source,
                score=score * conf,
                rerank=score,
                confidence=conf,
            )
        )
    return out


def apply_gate(scored: list[Hit], threshold: float = RERANK_MIN_SCORE) -> list[Hit]:
    """
    入口闸门。**独立成函数是为了让评测和线上共用同一段判定** ——
    评测里重写一遍过滤逻辑的话，校准出来的阈值和线上实际生效的会悄悄对不上。

    ⚠️ 顺序是 rerank 原始分数序，过滤用的却是降权后的 effective 分数。
       两者只在存在被降权切片（注入）时才不一致。改成按 effective 排序
       更符合降权的本意，但那是行为变更 —— 有了尺子之后用数据决定，
       不在这里凭感觉改。见 specs/006-m6-tuning/tasks.md W4。
    """
    return [h for h in scored if h.score >= threshold][:FINAL_TOP_K]


async def retrieve(tenant_id: UUID, expert_id: UUID, question: str) -> list[Hit]:
    """返回通过入口闸门的切片。空列表意味着「这个他没讲过」。"""
    with obs.span("retrieve", expert_id=str(expert_id), question=question) as sp:
        scored = await retrieve_scored(tenant_id, expert_id, question)
        hits = apply_gate(scored)
        sp.set(
            candidates=len(scored),
            passed=len(hits),
            threshold=RERANK_MIN_SCORE,
            # 排障时最想看的就是这个：分数是刚好没过，还是差得远
            top_scores=[round(h.score, 4) for h in scored[:5]],
            chunk_ids=[str(h.chunk_id) for h in hits],
        )

    log.info(
        "召回 expert=%s 候选=%d 通过闸门=%d 最高分=%.4f",
        expert_id, len(scored), len(hits), hits[0].score if hits else 0.0,
    )
    return hits
