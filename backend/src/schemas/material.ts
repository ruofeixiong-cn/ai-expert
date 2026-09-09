import { z } from "@hono/zod-openapi";

export const SourceType = z.enum(["paste", "file", "url"]).openapi("SourceType", {
  description: "paste=粘贴正文（最可靠）；file=上传文件；url=粘贴链接（只承诺公众号）",
});

/** 单条素材的字数上限。超出在上传时就拒，避免向量化成本失控。 */
export const MAX_MATERIAL_CHARS = 100_000;

export const CreateMaterialInput = z
  .discriminatedUnion("sourceType", [
    z.object({
      sourceType: z.literal("paste"),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(MAX_MATERIAL_CHARS),
    }),
    z.object({
      sourceType: z.literal("file"),
      title: z.string().min(1).max(200),
      filename: z.string().min(1).max(255),
      // M1 不接 OSS：文件在前端读成文本后直接传正文。
      // 二进制解析（docx/pdf）走 agent，见 specs/002-m1-ingestion/plan.md §2.1
      contentBase64: z.string().min(1),
    }),
    z.object({
      sourceType: z.literal("url"),
      url: z.string().url().openapi({ example: "https://mp.weixin.qq.com/s/xxxx" }),
    }),
  ])
  .openapi("CreateMaterialInput");

export const Material = z
  .object({
    id: z.string().uuid(),
    sourceType: SourceType,
    title: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    charCount: z.number().int(),
    contentHash: z.string().openapi({ description: "sha256，用于去重" }),
    // 该素材已产出的 chunk 数；0 表示还没构建过
    chunkCount: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .openapi("Material");

export const CreateMaterialResult = z
  .object({
    material: Material,
    deduplicated: z.boolean().openapi({
      description: "true 表示内容哈希已存在，复用了已有素材而非新建",
    }),
  })
  .openapi("CreateMaterialResult");
