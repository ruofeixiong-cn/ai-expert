"""
为七维提炼挑选有代表性的切片。

一个专家可能有几千个切片，全喂给模型既超上下文也烧钱。
需要的是【覆盖面】而不是【完整性】—— 提炼的是"这个人怎么想"，
不是"这个人说过的每一句话"。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.pipeline.config import MAX_EXTRACT_CHARS, MAX_EXTRACT_CHUNKS


@dataclass
class Sample:
    """喂给模型的一个切片。ref 是给模型看的短编号，chunk_id 是真实主键。"""

    ref: str
    chunk_id: UUID
    content: str


def pick(rows: list[tuple[UUID, UUID | None, str]]) -> list[Sample]:
    """
    rows: [(chunk_id, material_id, content)]，按入库顺序（近似原文顺序）。

    策略：按素材轮转取。
      每篇文章都要有代表 —— 否则博主传了 10 篇，模型只读到第一篇的内容，
      提炼出来的"他信什么"就只是那一篇的立场。

    每篇内部保持原文顺序：开头通常最能体现观点与风格。
    """
    by_material: dict[str, list[tuple[UUID, str]]] = {}
    for chunk_id, material_id, content in rows:
        by_material.setdefault(str(material_id), []).append((chunk_id, content))

    # 轮转：第 1 轮取每篇的第 1 个切片，第 2 轮取第 2 个……
    queues = list(by_material.values())
    picked: list[tuple[UUID, str]] = []
    budget = MAX_EXTRACT_CHARS
    round_idx = 0
    while queues and len(picked) < MAX_EXTRACT_CHUNKS:
        progressed = False
        for q in queues:
            if round_idx >= len(q):
                continue
            chunk_id, content = q[round_idx]
            if len(content) > budget or len(picked) >= MAX_EXTRACT_CHUNKS:
                queues = []
                break
            picked.append((chunk_id, content))
            budget -= len(content)
            progressed = True
        if not progressed:
            break
        round_idx += 1

    return [Sample(ref=f"c{i + 1}", chunk_id=cid, content=c) for i, (cid, c) in enumerate(picked)]
