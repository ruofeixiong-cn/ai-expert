"""
旁路观测（技术方案 §4.5）。

Langfuse 记录每次对话的召回分数、prompt 全文、token 与耗时 —— 调 RAG 时
最想看的就是这几样。但它是**旁路**的：只记录，不接管控制流。

这个模块存在的全部意义是把这句话变成代码里的硬约束：

1. **默认关。** `LANGFUSE_ENABLED=false` 时不 import langfuse、不建客户端、
   不发任何网络请求。CI 和测试不该因为一个观测组件而变红或变慢。
2. **装不上就自己退回关闭。** 没装 `--group obs` 却打开了开关，
   记一条警告然后继续跑 —— 不是抛异常。
3. **埋点永远不抛。** 每个入口都吞掉异常只记日志。
   观测组件把主链路搞挂，是本末倒置里最经典的一种。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator

from app.config import settings

log = logging.getLogger(__name__)

_client: Any = None
_state = "cold"  # cold | on | off


def _get() -> Any:
    """惰性拿客户端。任何一步不顺就永久转成 off，不重试。"""
    global _client, _state
    if _state != "cold":
        return _client
    if not settings.LANGFUSE_ENABLED:
        _state = "off"
        return None
    try:
        from langfuse import Langfuse  # 只有真正启用时才 import

        _client = Langfuse(
            host=settings.LANGFUSE_HOST,
            public_key=settings.LANGFUSE_PUBLIC_KEY,
            secret_key=settings.LANGFUSE_SECRET_KEY,
        )
        _state = "on"
    except Exception as exc:  # noqa: BLE001
        # 装不上、连不上、配错了 —— 都只是没有观测，不是故障
        log.warning("Langfuse 未启用（%s）。观测关闭，业务照常。", exc)
        _client, _state = None, "off"
    return _client


def enabled() -> bool:
    return _get() is not None


@contextmanager
def span(name: str, **attrs: Any) -> Iterator["Span"]:
    """
    一段可观测的过程。关闭时是个空壳，开销约等于一次属性赋值。

        with obs.span("retrieve", question=q) as s:
            hits = await retrieve(...)
            s.set(n_candidates=len(scored), top_score=hits[0].score if hits else 0)
    """
    s = Span(name, attrs)
    try:
        yield s
    finally:
        s._flush()


class Span:
    __slots__ = ("_name", "_attrs")

    def __init__(self, name: str, attrs: dict[str, Any]) -> None:
        self._name = name
        self._attrs = attrs

    def set(self, **attrs: Any) -> None:
        self._attrs.update(attrs)

    def _flush(self) -> None:
        client = _get()
        if client is None:
            return
        try:
            client.create_event(name=self._name, metadata=self._attrs)
        except Exception:  # noqa: BLE001
            # 埋点失败绝不影响回答。只记一次日志，不重试、不抛。
            log.debug("Langfuse 埋点失败 name=%s", self._name, exc_info=True)


def reset_for_tests() -> None:
    """测试改了 settings 之后要清掉惰性状态。"""
    global _client, _state
    _client, _state = None, "cold"
