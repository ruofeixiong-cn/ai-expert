import type { Schema } from "@/api/client";

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

export const isEvidenceless = (item: AnyItem) =>
  "evidenceChunkIds" in item && item.evidenceChunkIds.length === 0;

export function emptyItem(dim: Dim): AnyItem {
  if (dim === "boundaries") return { content: "", kind: "out_of_scope" };
  if (dim === "examples") return { question: "", answer: "", evidenceChunkIds: [] };
  return { content: "", confidence: 1, evidenceChunkIds: [] };
}
