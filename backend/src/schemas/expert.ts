import { z } from "@hono/zod-openapi";

export const ExpertStatus = z.enum(["building", "online", "offline"]).openapi("ExpertStatus");

export const BuildStage = z
  .enum(["queued", "parsing", "chunking", "embedding", "extracting", "done"])
  .openapi("BuildStage", {
    description: "构建阶段。extracting = 正在提炼七维专家模型。",
  });

export const BuildProgress = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    progress: z.number().int().min(0).max(100),
    stage: BuildStage.nullable(),
    error: z.string().nullable().openapi({ description: "失败时的可读原因" }),
    updatedAt: z.string().datetime(),
  })
  .openapi("BuildProgress");

export const Expert = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    status: ExpertStatus,
    materialCount: z.number().int(),
    chunkCount: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .openapi("Expert");

export const ExpertDetail = Expert.extend({
  // 最近一次构建；从没构建过则为 null
  lastBuild: BuildProgress.nullable(),
  hasDraft: z.boolean().openapi({ description: "是否已有 AI 生成的七维草稿" }),
  confirmedDimensions: z.array(z.string()).openapi({ description: "博主已确认的维度" }),
  shareSlug: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
}).openapi("ExpertDetail");

export const CreateExpertInput = z
  .object({ name: z.string().min(1).max(40) })
  .openapi("CreateExpertInput");

export const BuildResult = z
  .object({ jobId: z.string().uuid() })
  .openapi("BuildResult");
