"""
重排序。召回回来的候选按与问题的相关性重新打分，分数直接当 Confidence 用。

⚠️ gte-rerank-v2 的分数分布【偏低】。实测（2026-09-09）：
     "基金定投的申购费率通常打折"  vs "定投手续费"  → 0.2956
     "今天天气不错"                vs "定投手续费"  → 0.0059
   区分度约 50 倍，但绝对值很低。阈值按直觉设 0.5 或 0.7 会把所有召回结果
   滤光，表现成「这个专家什么都不知道」—— 而链路每一步看起来都正常。
   起步值 0.05，等 M6 有黄金问答集了再校准。

注意 rerank 走的是【百炼原生端点】，不是 OpenAI 兼容端点。
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

from app.config import settings

log = logging.getLogger(__name__)

_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"


class RerankProvider(Protocol):
    name: str

    async def rank(self, query: str, docs: list[str]) -> list[tuple[int, float]]:
        """返回 [(原始下标, 分数)]，按分数降序。"""
        ...


class FakeRerank:
    """
    确定性假打分：按字符重合度。仅用于 CI。

    ⚠️ 它【不理解语义】，只是让"相关的排前面"这个结构性质成立，
       用来验证闸门逻辑。检索质量必须用真 Provider 评估。
    """

    name = "fake"

    async def rank(self, query: str, docs: list[str]) -> list[tuple[int, float]]:
        q = set(query)
        scored = [
            (i, len(q & set(d)) / max(len(q), 1) * 0.6)  # 压到 0~0.6，贴近真实分布
            for i, d in enumerate(docs)
        ]
        return sorted(scored, key=lambda x: x[1], reverse=True)


class DashScopeRerank:
    name = "dashscope"

    async def rank(self, query: str, docs: list[str]) -> list[tuple[int, float]]:
        if not docs:
            return []
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                _ENDPOINT,
                headers={"Authorization": f"Bearer {settings.DASHSCOPE_API_KEY}"},
                json={
                    "model": settings.MODEL_RERANK,
                    "input": {"query": query, "documents": docs},
                    "parameters": {"return_documents": False, "top_n": len(docs)},
                },
            )
            resp.raise_for_status()
            results = resp.json()["output"]["results"]
        return [(r["index"], float(r["relevance_score"])) for r in results]


def get_provider() -> RerankProvider:
    choice = settings.RERANK_PROVIDER.lower()
    if choice == "fake":
        return FakeRerank()
    if choice == "dashscope" or (choice == "auto" and settings.DASHSCOPE_API_KEY):
        return DashScopeRerank()
    return FakeRerank()
