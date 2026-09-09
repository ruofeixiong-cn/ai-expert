import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { tenantTx } from "../db/client.js";
import { experts, materials, chunks, buildJobs } from "../db/schema/index.js";
import { notFound } from "../core/errors.js";
import * as agent from "../agent-client/index.js";
import type { z } from "@hono/zod-openapi";
import type { CreateMaterialInput } from "../schemas/material.js";

/**
 * 专家与素材。所有查询都走 tenantTx —— experts / materials / chunks / build_jobs
 * 都开了 RLS，忘记设置租户上下文的话会返回 0 行（fail-closed），
 * 表现为"资源不存在"而不是越权读到别人的数据。
 */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * ⚠️ 相关子查询里【不要】插值 drizzle 的 Column 对象，写字面量限定名。
 *
 * `${experts.id}` 会被渲染成裸的 `"id"` 而不是 `"experts"."id"`：
 *
 *     select "id", (select count(*)::int from materials m where m.expert_id = "id") from "experts"
 *                                                                            ^^^^
 * 子查询里 `"id"` 被内层的 `materials m` 抢走，变成 `m.expert_id = m.id` ——
 * 永远不成立，count 恒为 0。不报错，只是【静默返回错误结果】，
 * 是那种"功能看着正常、数字一直是 0"的 bug。
 *
 * 写成 `materials m where m.expert_id = experts.id` 就没有歧义。
 */

export async function createExpert(tenantId: string, ownerId: string, name: string) {
  return tenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .insert(experts)
      .values({ tenantId, ownerId, name })
      .returning();
    if (!row) throw notFound();
    return {
      id: row.id,
      name: row.name,
      status: row.status as "building" | "online" | "offline",
      materialCount: 0,
      chunkCount: 0,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listExperts(tenantId: string) {
  return tenantTx(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: experts.id,
        name: experts.name,
        status: experts.status,
        createdAt: experts.createdAt,
        materialCount: sql<number>`(select count(*)::int from materials m where m.expert_id = experts.id)`,
        chunkCount: sql<number>`(select count(*)::int from chunks c where c.expert_id = experts.id)`,
      })
      .from(experts)
      .orderBy(desc(experts.createdAt));

    return rows.map((r) => ({
      ...r,
      status: r.status as "building" | "online" | "offline",
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/**
 * 专家详情。
 *
 * ⚠️ 不属于当前租户时走的是同一条"查不到"路径 —— RLS 让跨租户查询直接返回 0 行，
 * 于是自然抛 404。不需要写 `if (row.tenantId !== tenantId) throw forbidden()`，
 * 也不该写：403 等于告诉攻击者"这个 id 存在，只是你没权限"。
 */
export async function getExpert(tenantId: string, id: string) {
  return tenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: experts.id,
        name: experts.name,
        status: experts.status,
        createdAt: experts.createdAt,
        materialCount: sql<number>`(select count(*)::int from materials m where m.expert_id = experts.id)`,
        chunkCount: sql<number>`(select count(*)::int from chunks c where c.expert_id = experts.id)`,
      })
      .from(experts)
      .where(eq(experts.id, id))
      .limit(1);
    if (!row) throw notFound("专家不存在");

    const [job] = await tx
      .select()
      .from(buildJobs)
      .where(eq(buildJobs.expertId, id))
      .orderBy(desc(buildJobs.createdAt))
      .limit(1);

    return {
      id: row.id,
      name: row.name,
      status: row.status as "building" | "online" | "offline",
      materialCount: row.materialCount,
      chunkCount: row.chunkCount,
      createdAt: row.createdAt.toISOString(),
      lastBuild: job
        ? {
            jobId: job.id,
            status: job.status as "queued" | "running" | "succeeded" | "failed",
            progress: job.progress,
            stage: (job.stage ?? null) as
              | "queued" | "parsing" | "chunking" | "embedding" | "done" | null,
            error: job.error,
            updatedAt: job.updatedAt.toISOString(),
          }
        : null,
    };
  });
}

/** 确认专家属于当前租户；不属于则 404。RLS 已经保证了，这里只是拿到 id。 */
async function assertExpert(tenantId: string, expertId: string) {
  const [row] = await tenantTx(tenantId, (tx) =>
    tx.select({ id: experts.id }).from(experts).where(eq(experts.id, expertId)).limit(1),
  );
  if (!row) throw notFound("专家不存在");
  return row.id;
}

export async function createMaterial(
  tenantId: string,
  expertId: string,
  input: z.infer<typeof CreateMaterialInput>,
) {
  await assertExpert(tenantId, expertId);

  // paste 已经是文本，不必绕一趟 agent；file / url 的提取工具链在 Python 侧
  let title: string | null;
  let text: string;
  let sourceUrl: string | null = null;

  if (input.sourceType === "paste") {
    title = input.title;
    text = input.content;
  } else if (input.sourceType === "file") {
    const r = await agent.extract({
      source_type: "file",
      filename: input.filename,
      content_base64: input.contentBase64,
    });
    title = input.title || r.title;
    text = r.text;
  } else {
    const r = await agent.extract({ source_type: "url", url: input.url });
    title = r.title;
    text = r.text;
    sourceUrl = input.url;
  }

  const contentHash = sha256(text);

  return tenantTx(tenantId, async (tx) => {
    // 去重在数据库层有唯一索引兜底，这里先查一次是为了返回 deduplicated 标志
    const [existing] = await tx
      .select()
      .from(materials)
      .where(and(eq(materials.expertId, expertId), eq(materials.contentHash, contentHash)))
      .limit(1);

    const row =
      existing ??
      (
        await tx
          .insert(materials)
          .values({
            tenantId,
            expertId,
            sourceType: input.sourceType,
            sourceUrl,
            title,
            rawText: text,
            contentHash,
          })
          .returning()
      )[0];
    if (!row) throw notFound();

    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(chunks)
      .where(eq(chunks.materialId, row.id));

    return {
      material: {
        id: row.id,
        sourceType: row.sourceType as "paste" | "file" | "url",
        title: row.title,
        sourceUrl: row.sourceUrl,
        charCount: row.rawText.length,
        contentHash: row.contentHash,
        chunkCount: c?.n ?? 0,
        createdAt: row.createdAt.toISOString(),
      },
      deduplicated: Boolean(existing),
    };
  });
}

export async function listMaterials(tenantId: string, expertId: string) {
  await assertExpert(tenantId, expertId);
  return tenantTx(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: materials.id,
        sourceType: materials.sourceType,
        title: materials.title,
        sourceUrl: materials.sourceUrl,
        contentHash: materials.contentHash,
        charCount: sql<number>`length(${materials.rawText})`,
        createdAt: materials.createdAt,
        chunkCount: sql<number>`(select count(*)::int from chunks c where c.material_id = materials.id)`,
      })
      .from(materials)
      .where(eq(materials.expertId, expertId))
      .orderBy(desc(materials.createdAt));

    return rows.map((r) => ({
      ...r,
      sourceType: r.sourceType as "paste" | "file" | "url",
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

export async function triggerBuild(tenantId: string, expertId: string) {
  await assertExpert(tenantId, expertId);
  // tenantId 由服务端从 JWT 取，绝不来自请求体 —— agent 侧还会再核对一次
  const r = await agent.requestBuild({ expert_id: expertId, tenant_id: tenantId });
  return { jobId: r.job_id };
}
