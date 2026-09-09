"""
七维提炼的性质测试。不调真实 API —— 把模型输出替换成受控的假数据，
专门验证【我们对模型输出做了什么】。
"""

from uuid import uuid4

import pytest

from app.pipeline import extract_model as em
from app.pipeline.sample import Sample


@pytest.fixture(autouse=True)
def _real_path(monkeypatch):
    """这些用例验的是【真实路径上的后处理逻辑】，所以要绕开 fake 分支。"""
    monkeypatch.setattr("app.config.settings.EXTRACT_PROVIDER", "dashscope")
    monkeypatch.setattr("app.config.settings.DASHSCOPE_API_KEY", "test-key")


def _samples(n=3):
    return [Sample(ref=f"c{i + 1}", chunk_id=uuid4(), content=f"第{i + 1}段内容") for i in range(n)]


def _fake_run(draft: em.RawDraft):
    class R:
        output = draft

    class A:
        async def run(self, _prompt):
            return R()

    return lambda: A()


def _item(content, evidence, conf=0.8):
    return em.DraftItem(content=content, confidence=conf, evidence=evidence)


def _draft(**kw):
    base = dict(persona=[], knowledge=[], beliefs=[], methodology=[], decision_rules=[], examples=[])
    base.update(kw)
    return em.RawDraft(**base)


# ── C2 ────────────────────────────────────────────────────────────────
async def test_evidence_ids_are_always_real_chunk_ids(monkeypatch):
    s = _samples()
    monkeypatch.setattr(em, "_agent", _fake_run(_draft(
        beliefs=[_item("定投优于择时", ["c1", "c3"])],
    )))
    d = await em.extract("老王", s)

    valid = {str(x.chunk_id) for x in s}
    for dim in ("persona", "knowledge", "beliefs", "methodology", "decisionRules"):
        for it in d[dim]:
            assert set(it["evidenceChunkIds"]) <= valid


# ── C3 ────────────────────────────────────────────────────────────────
async def test_fabricated_refs_are_dropped_not_fatal(monkeypatch):
    """
    模型编造出处编号时，丢掉编号、条目降级为「无证据」——
    而不是让整个提炼失败。不阻断流程，但把不确定性明明白白摆出来。
    """
    s = _samples()
    monkeypatch.setattr(em, "_agent", _fake_run(_draft(
        beliefs=[
            _item("有真出处的观点", ["c2"]),
            _item("全是编的出处", ["c99", "c404"]),
            _item("真假混着给", ["c1", "c88"]),
        ],
    )))
    d = await em.extract("老王", s)
    b = d["beliefs"]

    assert len(b) == 3, "条目不该被丢掉，只是失去证据"
    assert len(b[0]["evidenceChunkIds"]) == 1
    assert b[1]["evidenceChunkIds"] == [], "编造的出处必须被清空 → 前端标红"
    assert len(b[2]["evidenceChunkIds"]) == 1, "真假混合时只保留真的"


async def test_duplicate_refs_deduplicated(monkeypatch):
    s = _samples()
    monkeypatch.setattr(em, "_agent", _fake_run(_draft(
        knowledge=[_item("重复引用同一段", ["c1", "c1", "C1"])],
    )))
    d = await em.extract("老王", s)
    assert len(d["knowledge"][0]["evidenceChunkIds"]) == 1


# ── C4 ────────────────────────────────────────────────────────────────
async def test_boundaries_always_platform_template(monkeypatch):
    """
    禁区是通用合规风险，不是博主的个人特征。无论模型说什么，
    这一维恒为平台三层模板 —— RawDraft 里根本没有 boundaries 字段。
    """
    s = _samples()
    monkeypatch.setattr(em, "_agent", _fake_run(_draft(persona=[_item("风格", ["c1"])])))
    d = await em.extract("老王", s)

    assert len(d["boundaries"]) == 3
    assert {b["kind"] for b in d["boundaries"]} == {
        "impersonation", "professional_advice", "out_of_scope",
    }
    assert all(b["content"] for b in d["boundaries"])
    # 结构上就不给模型生成禁区的机会
    assert "boundaries" not in em.RawDraft.model_fields


# ── C5 ────────────────────────────────────────────────────────────────
async def test_examples_without_evidence_are_discarded(monkeypatch):
    """
    产品文档 §7.1：样本只能从内容【抽取】，绝不编造。
    没有出处的问答对就是编的 —— 直接丢弃，不像其他维度那样降级保留。
    """
    s = _samples()
    monkeypatch.setattr(em, "_agent", _fake_run(_draft(examples=[
        em.DraftExample(question="真问题", answer="真回答", evidence=["c1"]),
        em.DraftExample(question="编的问题", answer="编的回答", evidence=[]),
        em.DraftExample(question="假出处", answer="假回答", evidence=["c77"]),
    ])))
    d = await em.extract("老王", s)

    assert len(d["examples"]) == 1
    assert d["examples"][0]["question"] == "真问题"


# ── C11 ───────────────────────────────────────────────────────────────
async def test_model_failure_raises_readable_error(monkeypatch):
    s = _samples()

    class Boom:
        async def run(self, _p):
            raise RuntimeError("connection reset by peer")

    monkeypatch.setattr(em, "_agent", lambda: Boom())
    with pytest.raises(em.ExtractionError) as exc:
        await em.extract("老王", s)
    assert "提炼专家模型时出错" in str(exc.value)
    assert "Traceback" not in str(exc.value)


async def test_no_samples_fails_readably():
    with pytest.raises(em.ExtractionError) as exc:
        await em.extract("老王", [])
    assert "还没有可用于提炼" in str(exc.value)


async def test_seven_dimensions_always_present(monkeypatch):
    """C1：即使模型什么都没给出，七个维度也必须都在（可以为空数组）。"""
    monkeypatch.setattr(em, "_agent", _fake_run(_draft()))
    d = await em.extract("老王", _samples())
    assert set(d) == {
        "persona", "knowledge", "beliefs", "methodology",
        "decisionRules", "boundaries", "examples",
    }
