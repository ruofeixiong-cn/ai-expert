"""
七维专家模型提炼。

⚠️ 这是全项目【唯一】使用 Pydantic AI 的地方（见 agent/CLAUDE.md）。
   它只负责 schema 约束 + 输出校验 + 失败重试，不允许侵入检索链路。

最大的风险是【AI 过度推断】（产品文档 §8.3）：把博主从没表达过的观点脑补出来。
对一个要代表真人说话的产品，这是信任崩塌级别的问题 ——
博主看到"我"说了一句自己根本不认同的话，比看到"我不知道"糟糕一百倍。

三道防线：
  1. prompt 反复强调「宁可少写，不可编造」
  2. 强制每条给出引用编号，写不出出处的就不该写
  3. 事后校验引用编号 —— 模型编造的编号直接丢掉，该条目降级为「无证据」，
     前端标红告诉博主"这条是 AI 推断的"
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from app.config import settings
from app.pipeline.sample import Sample

log = logging.getLogger(__name__)


class ExtractionError(Exception):
    """可以展示给博主的失败原因。"""


# ─── 禁区：平台模板，不让 AI 生成 ────────────────────────────────────────────
#
# 产品文档 §7.2 把禁区拆成三层。这三类是【通用合规风险】，不是博主的个人特征 ——
# AI 从文章里提炼不出来，硬让它猜还会给博主"平台已经想好了"的错觉。
# 所以由平台给默认模板，博主在其上增删改。
BOUNDARY_TEMPLATES: list[dict[str, str]] = [
    {
        "kind": "impersonation",
        "content": "被问到是否为博主本人时，如实说明自己是基于博主内容训练的 AI 专家，不冒充本人。",
    },
    {
        "kind": "professional_advice",
        "content": "涉及投资、医疗、法律等需要专业资质的具体操作时，给出免责说明，不提供确定性建议。",
    },
    {
        "kind": "out_of_scope",
        "content": "博主没有公开表达过立场的话题，说明「这个问题他没有讲过」，不替博主编造观点。",
    },
]


# ─── 模型的原始输出结构 ──────────────────────────────────────────────────────
# 用短编号（c1/c2）而不是 UUID：36 字符的 UUID 几十个就占掉上千 token，
# 而且模型复制长随机串很容易出错。短标记省 token、不易抄错，
# 编造的编号我们一眼就能查出来。

class DraftItem(BaseModel):
    content: str = Field(description="一句话，用博主自己的说法")
    confidence: float = Field(ge=0, le=1, description="你对这条提炼的把握")
    evidence: list[str] = Field(description="出处编号，如 ['c3','c7']。写不出就留空数组。")


class DraftExample(BaseModel):
    question: str
    answer: str
    evidence: list[str]


class RawDraft(BaseModel):
    """注意：没有 boundaries —— 那是平台模板，不由模型生成。"""

    persona: list[DraftItem]
    knowledge: list[DraftItem]
    beliefs: list[DraftItem]
    methodology: list[DraftItem]
    decision_rules: list[DraftItem]
    examples: list[DraftExample]


INSTRUCTIONS = """\
你在为一位知识博主构建「思维说明书」，供他的 AI 专家在回答粉丝提问时使用。

## 铁律

1. **只提炼原文里明确表达过的内容。** 绝不推断、绝不补全、绝不用常识填空。
2. **每一条都必须给出出处编号。** 如果你写不出出处，说明原文没讲过 —— 那就不要写这一条。
3. **宁可少写，不可编造。** 一个维度只有两条真实内容，好过八条里混着三条你想象的。
4. 出处编号只能来自给你的材料，不要发明新编号。

为什么这么严：这份说明书会被用来【代表这位博主本人说话】。
博主看到自己"说"了一句从没说过的话，比看到"这个我没讲过"糟糕一百倍。

## 各维度的含义

- **persona 怎么说话**：语气、用词习惯、行文风格。例如「爱用具体数字论证」「常用反问开头」。
- **knowledge 知道什么**：他熟悉的领域与事实性知识点，不是观点。
- **beliefs 相信什么**：他的立场与判断，形如「我认为 X 比 Y 好」。
  **这一维最容易脑补，请格外克制** —— 只写他明确表过态的，语气中立的描述不算立场。
- **methodology 怎么分析**：他解决问题的步骤、框架、方法。
- **decision_rules 怎么决策**：**形如「当出现 A 情况时，就做 B」的可执行规则。**
  原文里没有明确规则就少写或不写，由博主自己补。

  ⚠️ beliefs 与 decision_rules 最容易混：
  「我认为普通人做不了择时」是 **belief**（一个判断）；
  「只有急着用钱或基金经理换人时才停定投」是 **decision_rule**（一条可执行的条件规则）。
  凡是能写成「什么情况下 → 怎么做」的，放 decision_rules，不要放 beliefs。
- **examples 真实样本**：从原文中**抽取**真实的问答对（问题可以由你根据原文内容概括，
  但答案必须是原文的内容）。**绝不编造**。抽不出就返回空数组。

每个维度控制在 3~8 条。
"""


def _build_prompt(expert_name: str, samples: list[Sample]) -> str:
    blocks = "\n\n".join(f"[{s.ref}]\n{s.content}" for s in samples)
    return (
        f"博主名称：{expert_name}\n\n"
        f"以下是他的 {len(samples)} 段内容，方括号里是出处编号：\n\n"
        f"{blocks}\n\n"
        "请据此提炼六个维度。记住：每条都要给出处编号，写不出出处的条目直接不要写。"
    )


def _agent():
    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model = OpenAIChatModel(
        settings.MODEL_EXTRACT,  # qwen-max：这一步每个专家只跑几次，
        provider=OpenAIProvider(  # 质量直接决定博主的第一印象，最不该省钱
            base_url=settings.DASHSCOPE_BASE_URL, api_key=settings.DASHSCOPE_API_KEY
        ),
    )
    # retries：结构不合法时把校验错误回喂给模型重试
    return Agent(model, output_type=RawDraft, instructions=INSTRUCTIONS, retries=2)


def _resolve(evidence: list[str], ref_map: dict[str, UUID]) -> list[str]:
    """
    把短编号映射回真实 chunk id。

    ⚠️ 模型编造的编号【直接丢掉】，而不是让整个提炼失败。
       该条目于是变成「无证据」，前端标红提醒博主这是 AI 推断的 ——
       这正是我们想要的结果：不阻断流程，但把不确定性明明白白摆出来。
    """
    seen: list[str] = []
    for ref in evidence:
        cid = ref_map.get(ref.strip().lower())
        if cid and str(cid) not in seen:
            seen.append(str(cid))
    return seen


def _to_items(raw: list[DraftItem], ref_map: dict[str, UUID]) -> list[dict[str, Any]]:
    return [
        {
            "content": it.content.strip(),
            "confidence": it.confidence,
            "evidenceChunkIds": _resolve(it.evidence, ref_map),
        }
        for it in raw
        if it.content.strip()
    ]


def _use_fake() -> bool:
    choice = settings.EXTRACT_PROVIDER.lower()
    if choice == "fake":
        return True
    if choice == "dashscope":
        return False
    return not settings.DASHSCOPE_API_KEY  # auto


def _fake_draft(samples: list[Sample]) -> dict[str, Any]:
    """
    确定性假草稿。仅用于 CI 与无网开发。

    ⚠️ 它【没有任何提炼能力】，只是把前几段内容原样搬进各维度，
       用于验证"结构对不对、证据链通不通"这类【工程性质】。
       提炼【质量】必须用真实 Provider 评估 —— 不能拿它测出来的结果
       当作"七维生成得准"。
    """
    def take(i: int, n: int) -> list[dict[str, Any]]:
        picked = samples[i : i + n]
        return [
            {
                "content": s.content.strip().replace("\n", " ")[:80],
                "confidence": 0.5,
                "evidenceChunkIds": [str(s.chunk_id)],
            }
            for s in picked
        ]

    return {
        "persona": take(0, 1),
        "knowledge": take(0, min(3, len(samples))),
        "beliefs": take(1, 1),
        "methodology": take(2, 1),
        "decisionRules": [],
        "boundaries": [dict(b) for b in BOUNDARY_TEMPLATES],
        "examples": (
            [
                {
                    "question": "这篇讲了什么？",
                    "answer": samples[0].content.strip()[:120],
                    "evidenceChunkIds": [str(samples[0].chunk_id)],
                }
            ]
            if samples
            else []
        ),
    }


async def extract(expert_name: str, samples: list[Sample]) -> dict[str, Any]:
    """返回可直接落 jsonb 的七维结构（字段名与 backend 契约一致，camelCase）。"""
    if not samples:
        raise ExtractionError("这个专家还没有可用于提炼的知识切片，请先上传内容并构建。")

    if _use_fake():
        log.warning("使用假的七维草稿（EXTRACT_PROVIDER=fake）—— 不具备提炼能力，勿用于质量评估")
        return _fake_draft(samples)

    ref_map = {s.ref: s.chunk_id for s in samples}

    try:
        result = await _agent().run(_build_prompt(expert_name, samples))
        draft = result.output
    except Exception as exc:  # noqa: BLE001
        log.exception("七维提炼失败 expert=%s", expert_name)
        raise ExtractionError(
            f"提炼专家模型时出错：{type(exc).__name__}。请稍后重试。"
        ) from exc

    return {
        "persona": _to_items(draft.persona, ref_map),
        "knowledge": _to_items(draft.knowledge, ref_map),
        "beliefs": _to_items(draft.beliefs, ref_map),
        "methodology": _to_items(draft.methodology, ref_map),
        "decisionRules": _to_items(draft.decision_rules, ref_map),
        # 平台模板，不来自模型
        "boundaries": [dict(b) for b in BOUNDARY_TEMPLATES],
        # 样本必须有出处 —— 产品文档 §7.1 明确要求「从内容抽取，不编造」。
        # 没有出处的问答对就是编的，直接丢弃。
        "examples": [
            {
                "question": e.question.strip(),
                "answer": e.answer.strip(),
                "evidenceChunkIds": ev,
            }
            for e in draft.examples
            if (ev := _resolve(e.evidence, ref_map)) and e.question.strip() and e.answer.strip()
        ],
    }
