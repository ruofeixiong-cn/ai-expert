import { z } from "@hono/zod-openapi";

/**
 * 七维专家模型 —— 见 MVP 产品文档 §7。
 *
 * 这是"这个人的思维说明书"，不只是文章搜索器：
 * 怎么说话、知道什么、信什么、怎么分析、怎么决策、什么不能答、真实样本。
 */

export const Dimension = z
  .enum(["persona", "knowledge", "beliefs", "methodology", "decisionRules", "boundaries", "examples"])
  .openapi("Dimension");

/**
 * 普通条目。
 *
 * `evidenceChunkIds` 是【防 AI 过度推断】的抓手（产品文档 §8.3 点名的最大的坑）：
 * 为空表示这条在原文里找不到出处，是模型脑补的 —— 前端必须标红。
 *
 * 这比"低置信度标红"更硬：置信度是模型的【自评】，它对自己编的内容也可能很自信；
 * 证据链是【可验证的事实】，我们会拿它去比对该专家真实存在的切片。
 */
export const ModelItem = z
  .object({
    content: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidenceChunkIds: z.array(z.string().uuid()).openapi({
      description: "出自哪几个知识切片。为空 = AI 推断，原文无出处，前端标红。",
    }),
  })
  .openapi("ModelItem");

/** 禁区。不带证据 —— 它是平台给的合规模板，不是从原文提炼的（见 plan §4）。 */
export const BoundaryKind = z
  .enum(["impersonation", "professional_advice", "out_of_scope"])
  .openapi("BoundaryKind", {
    description:
      "冒充风险 / 专业建议风险 / 立场越界 —— 产品文档 §7.2 的三层边界",
  });

export const BoundaryItem = z
  .object({ content: z.string().min(1), kind: BoundaryKind })
  .openapi("BoundaryItem");

/** 真实问答样本。只能从原文【抽取】，绝不编造 —— 所以证据不能为空。 */
export const ExampleItem = z
  .object({
    question: z.string().min(1),
    answer: z.string().min(1),
    evidenceChunkIds: z.array(z.string().uuid()).min(1),
  })
  .openapi("ExampleItem");

/**
 * ⚠️ 形状单独抽出来复用，而不是对具名组件直接 `.nullable()`。
 *
 * 写成 `ExpertModel.nullable()` 的话，@hono/zod-openapi 会把 nullable
 * 烘进【具名组件】本身，生成的类型变成 `ExpertModel = {...} | null`，
 * 于是前端 `keyof ExpertModel` 得到 never，整个维度遍历直接失效。
 * 组件本身不该是可空的 —— 可空性属于使用它的那个字段。
 */
const expertModelShape = {
  persona: z.array(ModelItem),
  knowledge: z.array(ModelItem),
  beliefs: z.array(ModelItem),
  methodology: z.array(ModelItem),
  decisionRules: z.array(ModelItem),
  boundaries: z.array(BoundaryItem),
  examples: z.array(ExampleItem),
};

// 仅供后端内部推导类型用。不注册成具名组件：它只出现在 ModelView 的两个
// 可空字段里，注册了反而会让生成的类型带上 | null（见上面的说明）。
export const ExpertModel = z.object(expertModelShape);

export const ModelView = z
  .object({
    /** AI 生成的草稿。还没构建过则为 null。 */
    draft: z.object(expertModelShape).nullable(),
    generatedAt: z.string().datetime().nullable(),
    /** 有效模型：确认过的维度用博主版本，未确认的用草稿。都没有则为 null。 */
    confirmed: z.object(expertModelShape).nullable(),
    confirmedDimensions: z.array(Dimension).openapi({
      description: "博主已确认的维度。未确认的维度按草稿「默认通过」。",
    }),
    /** 草稿基于多少个切片生成 —— 让博主知道 AI 读了多少内容。 */
    chunkCount: z.number().int(),
  })
  .openapi("ModelView");

/** 分块确认：一次提交一个维度。见产品文档 §8.4「分块确认」。 */
export const ConfirmDimensionInput = z
  .object({
    items: z.array(z.union([ModelItem, BoundaryItem, ExampleItem])).openapi({
      description: "该维度的最终内容。博主可增删改；提交即视为确认这一维度。",
    }),
  })
  .openapi("ConfirmDimensionInput");

export const PublishResult = z
  .object({
    shareSlug: z.string(),
    shareUrl: z.string(),
    publishedAt: z.string().datetime(),
  })
  .openapi("PublishResult");
