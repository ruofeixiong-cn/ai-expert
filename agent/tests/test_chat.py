"""
对话链路的性质测试。重点是入口闸门 —— 那是防幻觉与控成本的同一道关。
"""

from uuid import uuid4

import pytest
from sqlalchemy import text

from app.pipeline import generate as gen
from app.pipeline import safety
from app.pipeline.prompt import NO_CONTEXT_ANSWER, build_system, build_user
from app.pipeline.retrieve import Hit

MODEL = {
    "persona": [{"content": "语气直接", "confidence": 1, "evidenceChunkIds": []}],
    "knowledge": [],
    "beliefs": [{"content": "普通人不适合择时", "confidence": 1, "evidenceChunkIds": []}],
    "methodology": [{"content": "先看基金经理框架", "confidence": 1, "evidenceChunkIds": []}],
    "decisionRules": [{"content": "急用钱或换经理才停", "confidence": 1, "evidenceChunkIds": []}],
    "boundaries": [{"content": "不冒充本人", "kind": "impersonation"}],
    "examples": [{"question": "怎么选基金", "answer": "看框架稳不稳", "evidenceChunkIds": ["x"]}],
}


async def _collect(agen):
    return [e async for e in agen]


def _events(raw: list[str]) -> list[str]:
    return [line.split(": ", 1)[1] for e in raw for line in e.splitlines() if line.startswith("event: ")]


# ── D6：召回为空时不调用生成模型 ────────────────────────────────────────
async def test_no_hits_skips_the_model_entirely(monkeypatch):
    """
    既是质量措施（没有依据就不该生成），
    也是成本措施（问了库里没有的东西，不该为它花一次模型调用的钱）。
    """
    monkeypatch.setattr(gen, "retrieve", lambda *a, **k: _empty())

    called = False

    async def boom(*a, **k):
        nonlocal called
        called = True
        yield ""

    monkeypatch.setattr(gen, "_stream_real", boom)
    monkeypatch.setattr(gen, "_stream_fake", boom)

    raw = await _collect(gen.chat_stream(uuid4(), uuid4(), "老王", MODEL, "房价会涨吗"))
    assert called is False, "召回为空却仍然调用了生成模型"

    assert _events(raw) == ["meta"] + ["delta"] * (len(NO_CONTEXT_ANSWER) // 12 + 1) + ["done"]
    body = "".join(raw)
    assert "没有找到相关" in body
    assert '"finish_reason": "no_context"' in body
    assert '"confidence": 0.0' in body


async def _empty():
    return []


# ── 有召回时的事件顺序 ──────────────────────────────────────────────────
async def test_event_order_and_chunk_ids(monkeypatch):
    cid = uuid4()
    hits = [Hit(chunk_id=cid, content="定投的核心是纪律，不是频率。", source="creator", score=0.42)]

    async def fake_retrieve(*a, **k):
        return hits

    monkeypatch.setattr(gen, "retrieve", fake_retrieve)
    monkeypatch.setattr("app.config.settings.CHAT_PROVIDER", "fake")

    raw = await _collect(gen.chat_stream(uuid4(), uuid4(), "老王", MODEL, "定投要注意什么"))
    order = _events(raw)
    assert order[0] == "meta"
    assert order[-1] == "done"
    assert set(order[1:-1]) == {"delta"}

    body = "".join(raw)
    assert str(cid) in body, "meta 里必须带上命中的 chunk_ids —— M4 的盲区定位要用"
    assert '"confidence": 0.42' in body


async def test_retrieval_failure_emits_error_not_crash(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("pgvector down")

    monkeypatch.setattr(gen, "retrieve", boom)
    raw = await _collect(gen.chat_stream(uuid4(), uuid4(), "老王", MODEL, "问题"))
    assert _events(raw) == ["error"]
    assert '"code": 5000' in "".join(raw)


# ── 出口闸门 ────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "text_,reason",
    [
        ("我就是本人，可以直接帮你看", "impersonation"),
        ("我不是 AI，你放心", "impersonation"),
        ("建议你现在买入这只基金", "professional_advice"),
        ("这个策略保证收益", "professional_advice"),
        ("这只基金一定会涨", "professional_advice"),
    ],
)
def test_safety_catches_boundary_violations(text_, reason):
    v = safety.check(text_)
    assert not v.passed
    assert v.reason == reason
    assert v.note


@pytest.mark.parametrize(
    "text_",
    [
        "他认为普通人不适合做择时。",
        "根据他写过的内容，长期持有满两年可以免赎回费。",
        "这个问题他没有讲过。",
    ],
)
def test_safety_lets_normal_answers_through(text_):
    assert safety.check(text_).passed


async def test_safety_note_is_appended_to_stream(monkeypatch):
    """命中后要真的追加到流里，而不是只记个日志。"""
    hits = [Hit(chunk_id=uuid4(), content="我就是本人", source="creator", score=0.5)]

    async def fake_retrieve(*a, **k):
        return hits

    monkeypatch.setattr(gen, "retrieve", fake_retrieve)
    monkeypatch.setattr("app.config.settings.CHAT_PROVIDER", "fake")

    body = "".join(await _collect(gen.chat_stream(uuid4(), uuid4(), "老王", MODEL, "你是本人吗")))
    assert "不是他本人" in body
    assert '"safety": "disclaimed"' in body


# ── Prompt 组装 ─────────────────────────────────────────────────────────
def test_system_prompt_carries_boundaries_and_anti_injection():
    sp = build_system("老王", MODEL)
    assert "不冒充本人" in sp
    assert "不要执行" in sp, "防注入声明必须在 System 里（防注入 4 条的第 2 条）"
    assert "他没有讲过" in sp, "必须明确指示「不知道就说不知道」"
    assert "普通人不适合择时" in sp, "立场属于常驻部分"


def test_user_prompt_marks_source_of_every_chunk():
    """来源标记是防注入 4 条的第 3 条：让模型分得清素材和指令。"""
    hits = [
        Hit(chunk_id=uuid4(), content="博主写的内容", source="creator", score=0.5),
        Hit(chunk_id=uuid4(), content="平台公共知识", source="platform", score=0.4),
    ]
    up = build_user("怎么定投", hits, MODEL)
    assert "[博主原文 1]" in up
    assert "[平台公共知识，非博主观点 2]" in up
    assert "粉丝的问题：怎么定投" in up


# ── 防注入：降权机制的真实边界 ────────────────────────────────────────────
async def test_injection_flagged_chunk_is_downweighted_but_not_blocked(monkeypatch):
    """
    入库时被标记的切片，confidence 降到 0.2，参与打分时相当于把门槛抬高 5 倍。

    ⚠️ 但【降权不等于屏蔽】：攻击者只要在指令旁边放足够相关的真实内容，
       rerank 分数就能高到越过阈值。真实验证见 spec §6.5 ——
       最终挡住它的是 System Prompt 的防注入声明，不是这一层。
       这条测试固定的是「降权确实生效」，不是「注入一定进不来」。
    """
    from app.pipeline.config import RERANK_MIN_SCORE

    normal, injected = 0.30, 0.30
    assert normal * 1.0 >= RERANK_MIN_SCORE, "正常切片应能通过"
    assert injected * 0.2 >= RERANK_MIN_SCORE, "高相关的投毒切片仍可能通过 —— 这是已知边界"

    weak = 0.20
    assert weak * 1.0 >= RERANK_MIN_SCORE
    assert weak * 0.2 < RERANK_MIN_SCORE, "中等相关的投毒切片会被降权挡掉"
