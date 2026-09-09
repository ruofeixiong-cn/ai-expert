"""
入库前的清洗与注入检测 —— 防注入 4 条里的第 1 条和第 4 条。

风险来源是【上传内容本身可能被投毒】，不是"用户态度不好"：
善意博主粘贴一篇别人的文章，那篇文章里就可能藏着给模型的指令。
"""

from __future__ import annotations

import re

# 用来藏字的不可见字符。攻击者可以用零宽字符把指令插进正常句子中间，
# 人眼看不出来，模型照读不误。直接删掉，不影响任何正常内容。
_INVISIBLE = re.compile(r"[​-‏‪-‮⁠-⁤﻿]")
# 控制字符（保留 \n \t）
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "忽略/无视/忽视" + "以上/之前/…" 这个二元组合本身就足够特征化。
    # 后面的宾语不做要求 —— "请无视之前的要求" 和 "忽略以上所有指令" 都要覆盖。
    re.compile(r"(忽略|无视|忽视)(掉)?(以上|之前|上面|前面)"),
    re.compile(r"(不要|别)(再)?(理会|遵守|执行|管)(以上|之前|上面)"),
    re.compile(r"(系统|System)\s*(提示词|指令|prompt)", re.I),
    re.compile(r"ignore\s+(all\s+)?(previous|above|prior)\s+instructions?", re.I),
    re.compile(r"disregard\s+(all\s+)?(previous|above)", re.I),
    re.compile(r"you\s+are\s+now\s+", re.I),
    re.compile(r"<\|im_(start|end)\|>"),
    re.compile(r"\[\s*(system|assistant)\s*\]", re.I),
    re.compile(r"(现在|从现在开始)你(是|扮演)"),
)


def sanitize(text: str) -> str:
    """删掉不可见字符和控制字符。这一步是无损的 —— 正常内容里不该有它们。"""
    return _CONTROL.sub("", _INVISIBLE.sub("", text))


def detect_injection(text: str) -> bool:
    """
    命中注入特征。

    ⚠️ 命中【不删除】内容，只打标记并降 confidence。
       因为博主完全可能就在写一篇《如何防范提示词注入》的正常文章 ——
       删掉的话他的专家就答不出自己的专业内容了。
       降权让它进不了高置信度召回（M3 的 Confidence Check 会滤掉），
       但内容仍在库里。
    """
    return any(p.search(text) for p in INJECTION_PATTERNS)
