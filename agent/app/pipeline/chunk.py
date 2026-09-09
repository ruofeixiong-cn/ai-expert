"""
标题感知切分。

为什么不按固定字数硬切：
  中文文章里代词和省略主语极多。一段被孤立切出来的文字，丢了上级标题
  就失去了"在讲什么"的线索 —— 用户问"定投手续费怎么算"，那段讲手续费
  但通篇没出现"定投"二字的文字就召回不到。

  所以每个切片的文本前面拼上「文章标题 > 小节标题」。这是"上下文增强检索"
  的轻量版：几十行代码，召回率提升明显，是这一步性价比最高的一件事。

⚠️ 前缀进入的是 content 字段本身 —— 既用于向量化，也用于 M3 拼 prompt。
   这样模型生成时也知道这段出自哪一节。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.pipeline.config import (
    MAX_TOKENS, MIN_TOKENS, OVERLAP_RATIO, TARGET_TOKENS, count_tokens,
)

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")
# 断句优先级：段落 > 句号类 > 逗号类
_SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])")


@dataclass
class _Merged:
    path: tuple[str, ...]
    body: str
    demoted: bool


@dataclass
class Chunk:
    content: str          # 带标题路径前缀的完整文本
    heading_path: str     # 仅用于调试与展示
    index: int


def _blocks(text: str) -> list[tuple[tuple[str, ...], str]]:
    """把正文拆成 (标题路径, 段落) 列表，维护标题层级栈。"""
    stack: list[tuple[int, str]] = []
    buf: list[str] = []
    out: list[tuple[tuple[str, ...], str]] = []

    def flush() -> None:
        nonlocal buf
        para = "\n".join(buf).strip()
        if para:
            out.append((tuple(t for _, t in stack), para))
        buf = []

    for raw in text.split("\n"):
        line = raw.rstrip()
        m = _HEADING.match(line.strip())
        if m:
            flush()
            level = len(m.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, m.group(2).strip()))
        elif not line.strip():
            flush()
        else:
            buf.append(line)
    flush()
    return out


def _hard_split(para: str) -> list[str]:
    """单段就超过上限时按句子边界切开，避免把一句话拦腰截断。"""
    parts = [p for p in _SENTENCE_END.split(para) if p.strip()]
    out: list[str] = []
    cur = ""
    for p in parts:
        if cur and count_tokens(cur + p) > MAX_TOKENS:
            out.append(cur.strip())
            cur = p
        else:
            cur += p
    if cur.strip():
        out.append(cur.strip())
    return out or [para]


def _overlap_tail(text: str) -> str:
    """取上一片的尾部作为下一片的开头，避免答案正好落在切口上。"""
    n = int(len(text) * OVERLAP_RATIO)
    if n < 20:
        return ""
    tail = text[-n:]
    # 尽量从一个句子开头接上
    m = re.search(r"[。！？!?；;\n]", tail)
    return tail[m.end():].strip() if m else tail.strip()


def split(doc_title: str | None, text: str) -> list[Chunk]:
    blocks = _blocks(text)
    if not blocks:
        return []

    # ① 同一标题路径下的段落聚合到目标大小
    raw: list[tuple[tuple[str, ...], str]] = []
    cur_path: tuple[str, ...] | None = None
    cur_body = ""

    def emit() -> None:
        nonlocal cur_body
        if cur_body.strip():
            raw.append((cur_path or (), cur_body.strip()))
        cur_body = ""

    for path, para in blocks:
        if path != cur_path:
            emit()
            cur_path = path
        for piece in (_hard_split(para) if count_tokens(para) > MAX_TOKENS else [para]):
            if cur_body and count_tokens(cur_body + "\n\n" + piece) > TARGET_TOKENS:
                prev = cur_body
                emit()
                overlap = _overlap_tail(prev)
                cur_body = f"{overlap}\n\n{piece}" if overlap else piece
            else:
                cur_body = f"{cur_body}\n\n{piece}" if cur_body else piece
    emit()

    # ② 合并过小的相邻切片 —— 太碎的切片向量质量差，检索时噪声大。
    #
    #    合并两个【兄弟小节】时，被合并方的小节标题必须写进正文，
    #    否则前缀退到父级，两个小节的标题就都丢了 ——
    #    用户搜"误区二"会完全召回不到。
    merged: list[_Merged] = []
    for path, body in raw:
        if merged:
            prev = merged[-1]
            fits = count_tokens(prev.body + body) <= MAX_TOKENS
            if count_tokens(prev.body) < MIN_TOKENS and fits:
                # 同一小节内的碎片：直接接上
                if prev.path == path:
                    prev.body = f"{prev.body}\n\n{body}"
                    continue
                # 兄弟小节：前缀退到共同父级，两边的小节标题都写进正文
                siblings = len(prev.path) == len(path) and prev.path[:-1] == path[:-1] and bool(path)
                if siblings:
                    head = "" if prev.demoted else f"{prev.path[-1]}\n\n"
                    prev.body = f"{head}{prev.body}\n\n{path[-1]}\n\n{body}"
                    prev.path = path[:-1]
                    prev.demoted = True
                    continue
        merged.append(_Merged(path=path, body=body, demoted=False))

    # ③ 拼标题路径前缀（去掉相邻重复 —— 文章标题常常和 H1 是同一句话）
    out: list[Chunk] = []
    for i, m in enumerate(merged):
        crumbs: list[str] = []
        for c in (doc_title, *m.path):
            if c and (not crumbs or crumbs[-1] != c):
                crumbs.append(c)
        prefix = " > ".join(crumbs)
        out.append(
            Chunk(
                content=f"{prefix}\n\n{m.body}" if prefix else m.body,
                heading_path=prefix,
                index=i,
            )
        )
    return out
