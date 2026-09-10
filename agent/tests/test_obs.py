"""
可观测组件的两条硬约束（specs/006-m6-tuning/spec.md §6）。

观测把主链路搞挂，是本末倒置里最经典的一种。这两条测试就是拿来钉死它的。
"""

import sys

from app import obs


def test_disabled_by_default_and_never_imports_langfuse():
    """★ G9：默认关，且关着的时候连 import 都不该发生。"""
    obs.reset_for_tests()
    assert obs.enabled() is False
    # 关着还把 langfuse 拉进内存，说明"零开销"是假的
    assert "langfuse" not in sys.modules


def test_span_is_a_noop_when_disabled():
    obs.reset_for_tests()
    with obs.span("whatever", a=1) as s:
        s.set(b=2)
    # 没抛就是通过。关闭状态下 span 只是一次属性赋值。


def test_broken_client_does_not_break_anything(monkeypatch, caplog):
    """★ G10：埋点失败只记日志，绝不向上抛。"""
    obs.reset_for_tests()

    class Exploding:
        def create_event(self, **_):
            raise RuntimeError("langfuse 挂了")

    monkeypatch.setattr(obs, "_client", Exploding())
    monkeypatch.setattr(obs, "_state", "on")

    with obs.span("retrieve", question="定投手续费") as s:
        s.set(passed=3)
    # 没抛就是通过
    obs.reset_for_tests()


def test_unavailable_langfuse_falls_back_to_off(monkeypatch):
    """
    打开了开关但没装 `--group obs`：退回关闭，不是崩溃。

    观测装不上是运维问题，不该变成"专家答不了话"。
    """
    obs.reset_for_tests()
    monkeypatch.setattr(obs.settings, "LANGFUSE_ENABLED", True)
    monkeypatch.setitem(sys.modules, "langfuse", None)  # import 时会炸

    assert obs.enabled() is False
    assert obs._state == "off"
    obs.reset_for_tests()
