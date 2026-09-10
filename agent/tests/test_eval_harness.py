"""
尺子自己的刻度对不对。

M6 第一次跑真实模型时，「要点覆盖」只有 35.7%，看上去像 prompt 很差。
真实原因是黄金集里把同义词写成了一个组 —— 而组内是 AND ——
于是要求答案同时说出「两成」「20%」「百分之二十」三种写法。

**尺子有刻度错误的时候，它读出来的每一个数都是错的。**
所以匹配语义和黄金集本身都要有测试。
"""

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from eval import any_group, hit_groups  # noqa: E402

EVAL = Path(__file__).resolve().parents[1] / "eval"


# ─── 匹配语义 ────────────────────────────────────────────────────────────────

def test_within_a_group_is_and():
    assert hit_groups("手续费会吃掉收益", [["手续费", "收益"]]) is True
    assert hit_groups("手续费很高", [["手续费", "收益"]]) is False


def test_across_groups_is_or():
    assert hit_groups("吃掉近两成", [["两成"], ["20%"]]) is True
    assert hit_groups("吃掉 20%", [["两成"], ["20%"]]) is True
    assert hit_groups("吃掉不少", [["两成"], ["20%"]]) is False


def test_synonyms_in_one_group_can_never_match():
    """把同义词写成一个组就是要求答案同时说出所有写法 —— 这就是那个 bug。"""
    assert hit_groups("吃掉近两成", [["两成", "20%", "百分之二十"]]) is False


def test_empty_rule_passes():
    """没有期望不算失败 —— 否则没写规则的题目会白白拉低分数。"""
    assert hit_groups("随便什么", None) is True
    assert hit_groups("随便什么", []) is True


def test_any_group_is_false_on_empty():
    """must_not 相反：没规则就不可能命中。"""
    assert any_group("随便什么", None) is False
    assert any_group("准备 5 万港币", [["港币"]]) is True


# ─── 黄金集本身 ──────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def golden():
    return yaml.safe_load((EVAL / "golden.yaml").read_text())


def test_ids_are_unique(golden):
    ids = [g["id"] for g in golden]
    assert len(ids) == len(set(ids))


def test_categories_are_known(golden):
    assert {g["category"] for g in golden} <= {"covered", "uncovered", "boundary"}


def test_covered_and_uncovered_are_both_substantial(golden):
    """
    ★ G2：只有 covered 的话，阈值调到 0 就满分；只有 uncovered 的，调到 1 就满分。
    两类互相拉扯，中间才有真正的最优点。
    """
    n = {c: sum(g["category"] == c for g in golden) for c in ("covered", "uncovered")}
    assert n["covered"] >= 10 and n["uncovered"] >= 10, n


def test_no_multi_word_mention_groups(golden):
    """
    must_mention 的组内是 AND。要求答案同时命中多个说法几乎必然假性失败 ——
    这条测试就是拿来防止那个 bug 再犯的。
    """
    bad = [(g["id"], grp) for g in golden for grp in (g.get("must_mention") or []) if len(grp) > 1]
    assert not bad, f"同义词要拆成多个组，不是一个组：{bad}"


def test_uncovered_questions_declare_what_not_to_fabricate(golden):
    for g in golden:
        if g["category"] == "uncovered":
            assert g.get("must_not"), f"{g['id']} 没写 must_not —— 那这道题测不出编造"


def test_expert_model_has_all_seven_dimensions():
    m = yaml.safe_load((EVAL / "expert_model.yaml").read_text())
    for dim in ("persona", "beliefs", "methodology", "decisionRules", "boundaries", "examples"):
        assert m.get(dim), f"评测用的七维缺 {dim}"


def test_corpus_is_not_empty():
    assert list((EVAL / "corpus").glob("*.md"))
