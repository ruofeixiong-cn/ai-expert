import type { Schema } from "@/api/client";
// 运行期约束的唯一来源，和 api.d.ts 一样是 `make contract` 的产物（ADR-007）
import * as contract from "../../../../contracts/public/zod";

/**
 * 七维的形状从 ModelView.draft 推导 —— 那是契约里它唯一出现的地方。
 * 后端往七维里加一个维度，这里的遍历会立刻少一项，DIMENSIONS 表也会编译期报错。
 */
export type Model = NonNullable<Schema<"ModelView">["draft"]>;
export type Dim = keyof Model;
export type ModelItem = Schema<"ModelItem">;
export type BoundaryItem = Schema<"BoundaryItem">;
export type ExampleItem = Schema<"ExampleItem">;
export type AnyItem = ModelItem | BoundaryItem | ExampleItem;

/**
 * 七维的呈现规则。
 *
 * `attention` 决定默认展开还是折叠 —— 依据是产品文档 §8.2 的
 * 「AI 生成可靠度分三档」：AI 拿手的维度折叠起来让博主快速掠过，
 * 容易出错的维度默认展开逼他看一眼。
 *
 * 这是降低确认摩擦的关键：把博主的注意力放在真正需要他的地方，
 * 而不是让他从头到尾读七大段。
 */
export const DIMENSIONS: Array<{
  key: Dim;
  title: string;
  question: string;
  /** high = AI 拿手；medium = 容易脑补；low = 基本靠博主补；template = 平台模板；extract = 只做抽取 */
  attention: "high" | "medium" | "low" | "template" | "extract";
  hint?: string;
}> = [
  { key: "persona", title: "怎么说话", question: "语气、用词习惯、行文风格", attention: "high" },
  { key: "knowledge", title: "知道什么", question: "熟悉的领域与事实性知识", attention: "high" },
  {
    key: "beliefs", title: "相信什么", question: "立场与判断", attention: "medium",
    hint: "这一维 AI 最容易脑补。请逐条核对 —— 你的粉丝会把这些当成你本人的观点。",
  },
  { key: "methodology", title: "怎么分析", question: "解决问题的步骤与框架", attention: "medium" },
  {
    key: "decisionRules", title: "怎么决策", question: "「什么情况下 → 怎么做」的判断规则",
    attention: "low",
    hint: "这类规则往往藏在你脑子里没写出来，AI 提炼不到。这一块最值得你自己补几条。",
  },
  {
    key: "boundaries", title: "拒绝回答", question: "三类必须守住的风险边界",
    attention: "template",
    hint: "这是平台给的默认模板，不是从你的文章里提炼的。它保护你 —— 上线前必须确认。",
  },
  {
    key: "examples", title: "真实样本", question: "从你原文里抽出的问答对",
    attention: "extract",
    hint: "只做抽取，不编造。答案都来自你写过的内容。",
  },
];

export const BOUNDARY_KIND_LABEL: Record<string, string> = {
  impersonation: "冒充风险",
  professional_advice: "专业建议风险",
  out_of_scope: "立场越界",
};

/** 博主手写或改写过的条目（ADR-003）。存量数据没有这个字段，缺省视为 AI 写的。 */
export const isCreatorWritten = (item: AnyItem) =>
  "origin" in item && item.origin === "creator";

/**
 * 这一条是不是【AI 脑补】—— 标红的唯一依据。
 *
 * 只看"证据为空"是不够的：博主自己写的条目天然没有出处，
 * 那样会把博主本人的话指认成 AI 编造（F02）。必须先排除 creator。
 */
export const isAiInferred = (item: AnyItem) =>
  !isCreatorWritten(item) && "evidenceChunkIds" in item && item.evidenceChunkIds.length === 0;

/** 每个维度对应契约里的哪种条目 —— 和后端 validateItems 的分派一致。 */
const ITEM_SCHEMA = {
  boundaries: contract.BoundaryItem,
  examples: contract.ExampleItem,
  default: contract.ModelItem,
} as const;

const FIELD_LABEL: Record<string, string> = {
  content: "内容",
  question: "问题",
  answer: "回答",
  evidenceChunkIds: "原文出处",
  kind: "边界类型",
  confidence: "置信度",
};

type Issue = { code: string; path: PropertyKey[]; minimum?: unknown; maximum?: unknown };

/** 把 zod 的英文报错翻成博主看得懂的一句话。 */
function explain(n: number, issue: Issue): string {
  const field = FIELD_LABEL[String(issue.path[0] ?? "")] ?? String(issue.path[0] ?? "内容");
  if (issue.code === "too_small") {
    return Number(issue.minimum) <= 1
      ? `第 ${n} 条的${field}还没填，填上或删掉再确认`
      : `第 ${n} 条的${field}至少要 ${issue.minimum} 个`;
  }
  if (issue.code === "too_big") return `第 ${n} 条的${field}超出上限（最多 ${issue.maximum}）`;
  if (issue.code === "invalid_type") return `第 ${n} 条缺少${field}`;
  return `第 ${n} 条的${field}不符合要求`;
}

/**
 * 提交前按契约的约束先查一遍，别让博主等一个必然的 400（F03）。
 * 返回第一条问题的中文说明；没有问题返回 null。
 *
 * 约束来自 `contracts/public/zod.ts`（`make contract` 生成，见 ADR-007）——
 * 以前这里是【手抄】后端的 min/max，抄漏了类型检查照样全过、运行时必然 400。
 * 现在后端加一条约束，这里自动就有。
 *
 * ⚠️ 唯一还需要手写的是【条件约束】：ExampleItem 的证据要求随 origin 分叉，
 *    这表达不进 JSON Schema，所以生成的 schema 里没有（ADR-003 / ADR-007）。
 */
export function validateItems(dim: Dim, items: AnyItem[]): string | null {
  const schema = dim in ITEM_SCHEMA
    ? ITEM_SCHEMA[dim as keyof typeof ITEM_SCHEMA]
    : ITEM_SCHEMA.default;

  for (const [i, it] of items.entries()) {
    const n = i + 1;
    const parsed = schema.safeParse(it);
    if (!parsed.success) return explain(n, parsed.error.issues[0] as Issue);

    // 条件约束，生成不出来：博主自己写的样本没有出处是正常的，AI 提炼的必须有
    if (dim === "examples") {
      const e = it as ExampleItem;
      if (!isCreatorWritten(e) && e.evidenceChunkIds.length === 0) {
        return `第 ${n} 条没有原文出处。AI 提炼的样本只能来自原文，请删掉它`;
      }
    }
  }
  return null;
}

/** 新加的条目一律是博主写的 —— 这是 origin 字段存在的全部意义。 */
export function emptyItem(dim: Dim): AnyItem {
  if (dim === "boundaries") return { content: "", kind: "out_of_scope" };
  if (dim === "examples") {
    return { question: "", answer: "", evidenceChunkIds: [], origin: "creator" };
  }
  return { content: "", confidence: 1, evidenceChunkIds: [], origin: "creator" };
}
