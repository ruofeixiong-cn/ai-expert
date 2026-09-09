import { z } from "@hono/zod-openapi";

/** 统一响应体 {code, message, data} —— 见 contracts/README.md 的错误码表。 */
export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().openapi({ example: 0, description: "0 = 成功；非 0 见 contracts/README.md" }),
    message: z.string().openapi({ example: "ok" }),
    data,
  });

export const ok = <T>(data: T) => ({ code: 0, message: "ok", data });

export const ErrorBody = z
  .object({
    code: z.number().openapi({ example: 1401 }),
    message: z.string().openapi({ example: "未登录" }),
    data: z.null(),
  })
  .openapi("ErrorBody");

/** 需要认证的接口统一挂这三个错误响应，前端按 code 分支。 */
export const authedErrors = {
  401: { description: "未登录或 token 失效", content: { "application/json": { schema: ErrorBody } } },
  404: {
    description: "资源不存在，或不属于当前租户（刻意不区分，避免泄露存在性）",
    content: { "application/json": { schema: ErrorBody } },
  },
} as const;

export const UuidParam = z.string().uuid().openapi({ example: "5f8c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f" });
