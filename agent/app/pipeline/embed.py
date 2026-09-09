"""
向量化。两个实现，由 EMBEDDING_PROVIDER 选择。

为什么要留一个假实现：
  CI 不该为了跑测试去调真实 API —— 会 flaky、会花钱、会因为限流随机失败。
  假向量是【确定性】的（同文本永远同向量），所以"同内容 → 同向量"
  这类断言仍然成立。

⚠️ 假向量【没有语义】：余弦相似度只反映哈希碰撞，不反映意思相近。
   所以 M3 的检索质量测试必须用真 Provider，不能拿假向量测召回率
   然后以为没问题。
"""

from __future__ import annotations

import hashlib
import math
import struct
from typing import Protocol

from app.config import settings
from app.pipeline.config import EMBED_BATCH_SIZE


class EmbeddingProvider(Protocol):
    name: str
    dim: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def _normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class FakeEmbedding:
    """确定性伪向量：sha256 播种，同文本永远同向量。仅用于 CI 与无网开发。"""

    name = "fake"

    def __init__(self, dim: int) -> None:
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            vec: list[float] = []
            counter = 0
            while len(vec) < self.dim:
                digest = hashlib.sha256(f"{text}#{counter}".encode()).digest()
                # 每 4 字节取一个 [-1, 1) 的浮点
                for i in range(0, len(digest), 4):
                    if len(vec) >= self.dim:
                        break
                    (n,) = struct.unpack(">I", digest[i : i + 4])
                    vec.append(n / 2**31 - 1.0)
                counter += 1
            out.append(_normalize(vec))
        return out


class DashScopeEmbedding:
    """百炼 text-embedding-v3，走 OpenAI 兼容端点（换供应商只改 base_url）。"""

    name = "dashscope"

    def __init__(self, dim: int) -> None:
        from openai import AsyncOpenAI

        self.dim = dim
        self._model = settings.MODEL_EMBEDDING
        self._client = AsyncOpenAI(
            api_key=settings.DASHSCOPE_API_KEY,
            base_url=settings.DASHSCOPE_BASE_URL,
            max_retries=2,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[i : i + EMBED_BATCH_SIZE]
            resp = await self._client.embeddings.create(
                model=self._model, input=batch, dimensions=self.dim
            )
            # 供应商不保证返回顺序，按 index 排回去
            out.extend(d.embedding for d in sorted(resp.data, key=lambda d: d.index))
        return out


def get_provider() -> EmbeddingProvider:
    choice = settings.EMBEDDING_PROVIDER.lower()
    if choice == "fake":
        return FakeEmbedding(settings.EMBEDDING_DIM)
    if choice == "dashscope" or (choice == "auto" and settings.DASHSCOPE_API_KEY):
        return DashScopeEmbedding(settings.EMBEDDING_DIM)
    return FakeEmbedding(settings.EMBEDDING_DIM)
