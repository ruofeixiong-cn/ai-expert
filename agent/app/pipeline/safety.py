"""
出口闸门（产品文档 §6.3 的 Safety Check）。规则来源是七维里的 boundaries。

⚠️ 流式下做不到边流边审：文字已经在往用户屏幕上打了。
   所以做法是【先流给用户、同时缓冲全文，流结束后校验一次】，
   命中则追加一段免责说明。这是可接受的取舍 ——
   代价是用户会先看到那句话再看到免责，好处是首字延迟不受影响。

M3 用规则不用模型：一次生成再加一次审核模型调用，延迟和成本都翻倍，
而 MVP 阶段要挡的就是那么几类明确措辞。重武器等开放分享/API 时再上
（产品文档 §4 明确把内容审核放到了后期）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 冒充本人：产品文档 §7.2 的第一层边界
_IMPERSONATION = (
    re.compile(r"我(就)?是(本人|真人)"),
    re.compile(r"我不是\s*AI"),
    re.compile(r"我(本人|亲自)(可以|能够|会)(为你|帮你)"),
)

# 给确定性专业建议：第二层边界
_ADVICE = (
    re.compile(r"(建议|推荐)你(现在)?(买入|卖出|全仓|梭哈|抄底)"),
    re.compile(r"(一定|肯定|必然)(会)?(涨|跌|赚|亏)"),
    re.compile(r"(保证|稳赚|包赚|无风险)(收益|回报|不亏)?"),
    re.compile(r"你应该(立刻|马上|现在)(买|卖|清仓)"),
)

IMPERSONATION_NOTE = (
    "\n\n---\n（补充说明：我是基于这位博主公开内容训练的 AI 专家，不是他本人。）"
)
ADVICE_NOTE = (
    "\n\n---\n（风险提示：以上只是对博主公开观点的整理，不构成投资、医疗或法律建议。"
    "具体决策请结合自身情况，必要时咨询有资质的专业人士。）"
)


@dataclass
class Verdict:
    """`passed` 为 False 时，note 是要追加到回答末尾的说明。"""

    passed: bool
    note: str
    reason: str


def check(answer: str) -> Verdict:
    if any(p.search(answer) for p in _IMPERSONATION):
        return Verdict(False, IMPERSONATION_NOTE, "impersonation")
    if any(p.search(answer) for p in _ADVICE):
        return Verdict(False, ADVICE_NOTE, "professional_advice")
    return Verdict(True, "", "pass")
