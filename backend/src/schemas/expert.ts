import { z } from "@hono/zod-openapi";

export const ExpertStatus = z.enum(["building", "online", "offline"]).openapi("ExpertStatus");

export const BuildStage = z
  .enum(["queued", "parsing", "chunking", "embedding", "done"])
  .openapi("BuildStage", { description: "构建阶段，对应进度 0/20/40/70/100" });

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
}).openapi("ExpertDetail");

export const CreateExpertInput = z
  .object({ name: z.string().min(1).max(40) })
  .openapi("CreateExpertInput");

export const BuildResult = z
  .object({ jobId: z.string().uuid() })
  .openapi("BuildResult");
