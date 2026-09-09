"""
流式生成 + 双闸门编排。产出 SSE 事件，协议见 contracts/README.md。
"""

from __future__ import annotations

import json
import logging
import time
from typing import AsyncIterator
from uuid import UUID, uuid4

from app.config import settings
from app.pipeline import safety
from app.pipeline.prompt import NO_CONTEXT_ANSWER, build_system, build_user
from app.pipeline.retrieve import Hit, retrieve

log = logging.getLogger(__name__)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _use_fake() -> bool:
    choice = settings.CHAT_PROVIDER.lower()
    if choice == "fake":
        return True
    if choice == "dashscope":
        return False
    return not settings.DASHSCOPE_API_KEY


async def _stream_fake(hits: list[Hit]) -> AsyncIterator[str]:
    """
    确定性假回答：把召回到的第一段原文复述一遍。

    ⚠️ 没有任何生成能力。它能验「召回的内容确实进了回答」这类结构性质，
       但回答质量必须用真模型评估。
    """
    text = f"根据他写过的内容：{hits[0].content.strip()[:120]}" if hits else NO_CONTEXT_ANSWER
    for i in range(0, len(text), 12):
        yield text[i : i + 12]


async def _stream_real(system: str, user: str) -> AsyncIterator[str]:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        api_key=settings.DASHSCOPE_API_KEY,
        base_url=settings.DASHSCOPE_BASE_URL,
        max_retries=1,
    )
    stream = await client.chat.completions.create(
        model=settings.MODEL_CHAT,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        stream=True,
        stream_options={"include_usage": True},
        temperature=0.6,
        max_tokens=800,
    )
    async for chunk in stream:
        if chunk.usage:
            # 用量在最后一个 chunk 上，塞进闭包外的容器
            _stream_real.usage = (chunk.usage.prompt_tokens, chunk.usage.completion_tokens)  # type: ignore[attr-defined]
        if chunk.choices and (delta := chunk.choices[0].delta.content):
            yield delta


async def chat_stream(
    tenant_id: UUID, expert_id: UUID, expert_name: str, model: dict, question: str
) -> AsyncIterator[str]:
    started = time.monotonic()
    message_id = uuid4()

    try:
        hits = await retrieve(tenant_id, expert_id, question)
    except Exception:  # noqa: BLE001
        log.exception("召回失败 expert=%s", expert_id)
        yield sse("error", {"code": 5000, "message": "检索服务暂时不可用，请稍后重试"})
        return

    yield sse(
        "meta",
        {
            "message_id": str(message_id),
            "confidence": round(hits[0].score, 4) if hits else 0.0,
            "chunk_ids": [str(h.chunk_id) for h in hits],
        },
    )

    # ── 入口闸门为空：直接回答「没讲过」，不调用生成模型 ──
    #
    # 既是质量措施（防幻觉：没有依据就不要生成），
    # 也是成本措施（问了库里没有的东西，不该为它花一次模型调用的钱）。
    if not hits:
        for i in range(0, len(NO_CONTEXT_ANSWER), 12):
            yield sse("delta", {"text": NO_CONTEXT_ANSWER[i : i + 12]})
        yield sse(
            "done",
            {
                "finish_reason": "no_context",
                "safety": "pass",
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "answer": NO_CONTEXT_ANSWER,
            },
        )
        return

    system = build_system(expert_name, model)
    user = build_user(question, hits, model)

    buf: list[str] = []
    usage = (0, 0)
    try:
        if _use_fake():
            async for piece in _stream_fake(hits):
                buf.append(piece)
                yield sse("delta", {"text": piece})
        else:
            _stream_real.usage = (0, 0)  # type: ignore[attr-defined]
            async for piece in _stream_real(system, user):
                buf.append(piece)
                yield sse("delta", {"text": piece})
            usage = getattr(_stream_real, "usage", (0, 0))
    except Exception:  # noqa: BLE001
        log.exception("生成失败 expert=%s", expert_id)
        yield sse("error", {"code": 5000, "message": "回答生成失败，请重试"})
        return

    answer = "".join(buf)

    # ── 出口闸门：流已经发完了，这里只能追加 ──
    verdict = safety.check(answer)
    if not verdict.passed:
        yield sse("delta", {"text": verdict.note})
        answer += verdict.note
        log.warning("出口闸门命中 %s expert=%s", verdict.reason, expert_id)

    yield sse(
        "done",
        {
            "finish_reason": "stop",
            "safety": "pass" if verdict.passed else "disclaimed",
            "prompt_tokens": usage[0],
            "completion_tokens": usage[1],
            "latency_ms": int((time.monotonic() - started) * 1000),
            # backend 要落库，不必自己再拼一遍增量
            "answer": answer,
        },
    )
