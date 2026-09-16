import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { tenantTx } from "../db/client.js";
import { experts, expertModelDrafts } from "../db/schema/index.js";
import { badRequest, notFound } from "../core/errors.js";
import * as agent from "../agent-client/index.js";
import { ExpertModel, ModelItem, BoundaryItem, ExampleItem } from "../schemas/model.js";
import type { z } from "@hono/zod-openapi";

type Model = z.infer<typeof ExpertModel>;
type Dim = keyof Model;

const DIMENSIONS: Dim[] = [
  "persona", "knowledge", "beliefs", "methodology", "decisionRules", "boundaries", "examples",
];

const EMPTY: Model = {
  persona: [], knowledge: [], beliefs: [], methodology: [],
  decisionRules: [], boundaries: [], examples: [],
};

/**
 * 有效模型 = 逐维度取值：博主确认过的用他的版本，没确认的用草稿。
 *
 * 这就是产品文档 §8.4 的「默认通过」——
 * 博主只需要改他在意的那几块，剩下的不动就算同意。
 */
function effective(
  draft: Model | null,
  confirmed: Partial<Model> | null,
  confirmedDims: string[],
): Model | null {
  if (!draft && !confirmed) return null;
  const out = { ...EMPTY };
  for (const d of DIMENSIONS) {
    const useConfirmed = confirmedDims.includes(d) && confirmed?.[d];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[d] = useConfirmed ? confirmed![d] : (draft?.[d] ?? []);
  }
  return out;
}

async function load(tenantId: string, expertId: string) {
  return tenantTx(tenantId, async (tx) => {
    const [e] = await tx
      .select({
        id: experts.id,
        name: experts.name,
        confirmedModel: experts.confirmedModel,
        confirmedDimensions: experts.confirmedDimensions,
        // 线上快照整份取回来，用于判断"改了但还没推上线"（ADR-009）
        publishedModel: experts.expertModel,
        shareSlug: experts.shareSlug,
        publishedAt: experts.publishedAt,
      })
      .from(experts)
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("专家不存在");

    const [d] = await tx
      .select()
      .from(expertModelDrafts)
      .where(eq(expertModelDrafts.expertId, expertId))
      .limit(1);

    return { expert: e, draft: d ?? null };
  });
}

/**
 * 内容级比对：递归按 key 排序再 stringify（ADR-009）。
 *
 * 两边今天都来自 jsonb，Postgres 本来就会重排 key，直接 stringify 够用 ——
 * 但这个前提太脆：哪天有一处改成在 JS 里拼对象，就会开始报假阳性，
 * 症状是"提示一直在，点了上线也不消失"，很难查。规范化一次就不用再想。
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

const sameModel = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function view(e: Awaited<ReturnType<typeof load>>) {
  const draft = (e.draft?.model ?? null) as Model | null;
  const confirmed = (e.expert.confirmedModel ?? null) as Partial<Model> | null;
  const dims = e.expert.confirmedDimensions ?? [];
  const published = e.expert.publishedModel ?? null;
  const effectiveModel = effective(draft, confirmed, dims);
  return {
    draft,
    generatedAt: e.draft?.generatedAt?.toISOString() ?? null,
    confirmed: effectiveModel,
    confirmedDimensions: dims as Dim[],
    chunkCount: e.draft?.chunkCount ?? 0,
    // 没上线过就没有"没推上线的改动"可言 —— 那时该提示的是"去上线"
    hasUnpublishedChanges: published !== null && !sameModel(effectiveModel, published),
  };
}

export async function getModel(tenantId: string, expertId: string) {
  return view(await load(tenantId, expertId));
}

/**
 * 契约里 items 是三种条目类型的联合，但每个维度只接受其中一种。
 * 不在这里按维度收紧的话，博主可以往 boundaries 里塞一个带 confidence 的
 * 普通条目 —— 结构上合法，语义上是垃圾，而且 M3 拼 prompt 时才会炸。
 */
function validateItems(dimension: Dim, items: unknown[]) {
  const schema =
    dimension === "boundaries" ? BoundaryItem : dimension === "examples" ? ExampleItem : ModelItem;
  const parsed = schema.array().safeParse(items);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      `${dimension} 的条目格式不对：${issue?.path.join(".")} ${issue?.message}`,
    );
  }
  return parsed.data;
}

export async function confirmDimension(
  tenantId: string,
  expertId: string,
  dimension: Dim,
  items: unknown[],
) {
  const validated = validateItems(dimension, items);
  const current = await load(tenantId, expertId);

  const confirmed = { ...((current.expert.confirmedModel ?? {}) as Partial<Model>) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (confirmed as any)[dimension] = validated;

  const dims = new Set(current.expert.confirmedDimensions ?? []);
  dims.add(dimension);

  await tenantTx(tenantId, (tx) =>
    tx
      .update(experts)
      .set({
        confirmedModel: confirmed,
        confirmedDimensions: [...dims],
        updatedAt: new Date(),
      })
      .where(eq(experts.id, expertId)),
  );

  return view(await load(tenantId, expertId));
}

export async function regenerate(tenantId: string, expertId: string) {
  const { expert } = await load(tenantId, expertId);
  // 已确认的维度不受影响 —— 草稿和确认是分开存的
  const r = await agent.requestModelExtraction({
    expert_id: expert.id,
    tenant_id: tenantId,
  });
  return { jobId: r.job_id };
}

const slug = () => randomBytes(8).toString("base64url").slice(0, 10);

export async function publish(tenantId: string, expertId: string, baseUrl: string) {
  const current = await load(tenantId, expertId);
  const model = view(current).confirmed;

  if (!model) throw badRequest("还没有生成专家模型，请先上传内容并构建。");

  /**
   * 禁区是合规生命线（产品文档 §7.2）—— 必须由博主主动确认才能上线。
   * 这是唯一的硬门槛；其余维度按「默认通过」，不给博主设障碍。
   */
  if (model.boundaries.length === 0) {
    throw badRequest("上线前请先设置「拒绝回答」的边界 —— 这是保护你的合规底线。");
  }

  return tenantTx(tenantId, async (tx) => {
    // 重复上线不改变已有短链：粉丝手里的链接不能失效
    let shareSlug = current.expert.shareSlug;
    if (!shareSlug) {
      for (let i = 0; i < 5 && !shareSlug; i++) {
        const candidate = slug();
        const [taken] = await tx
          .select({ id: experts.id })
          .from(experts)
          .where(eq(experts.shareSlug, candidate))
          .limit(1);
        if (!taken) shareSlug = candidate;
      }
      if (!shareSlug) throw badRequest("生成分享链接失败，请重试。");
    }

    const publishedAt = new Date();
    await tx
      .update(experts)
      .set({
        // 上线即快照：之后怎么改草稿都不影响线上，直到再次点上线。
        // 否则博主重新生成七维会悄悄改变付费粉丝拿到的东西。
        expertModel: model,
        shareSlug,
        status: "online",
        publishedAt,
        updatedAt: publishedAt,
      })
      .where(eq(experts.id, expertId));

    return {
      shareSlug,
      shareUrl: `${baseUrl}/s/${shareSlug}`,
      publishedAt: publishedAt.toISOString(),
    };
  });
}
