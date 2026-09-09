import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { env } from "./env.js";
import { getDb } from "./db/client.js";
import { envelope, ok } from "./schemas/common.js";
import * as R from "./routes/definitions.js";

/**
 * 契约已冻结、实现待补的接口先挂这个 handler。
 * 返回 501 而不是假数据 —— 假数据会让前端以为接口能用。
 */
const notImplemented = (): never => {
  throw new HTTPException(501, { message: "尚未实现（M1 实现中）" });
};

const HealthData = z
  .object({
    service: z.string().openapi({ example: "backend" }),
    status: z.literal("ok"),
  })
  .openapi("HealthData");

const ReadyData = z
  .object({
    database: z.enum(["ok", "down"]),
    agent: z.enum(["ok", "down"]),
  })
  .openapi("ReadyData");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "存活探针（不触碰任何依赖）",
  responses: {
    200: {
      description: "服务存活",
      content: { "application/json": { schema: envelope(HealthData) } },
    },
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/readyz",
  tags: ["system"],
  summary: "就绪探针（检查数据库与 agent 可达）",
  responses: {
    200: {
      description: "各依赖的状态；任一为 down 时 HTTP 仍为 200，由调用方判断",
      content: { "application/json": { schema: envelope(ReadyData) } },
    },
  },
});

export function createApp() {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, (c) => c.json(ok({ service: "backend", status: "ok" as const })));

  app.openapi(readyRoute, async (c) => {
    const database = await getDb()
      .execute(sql`select 1`)
      .then(() => "ok" as const)
      .catch(() => "down" as const);

    const agent = await fetch(`${env.AGENT_URL}/internal/health`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => (r.ok ? ("ok" as const) : ("down" as const)))
      .catch(() => "down" as const);

    return c.json(ok({ database, agent }));
  });

  // ── M1 接口：契约已冻结，实现见 specs/002-m1-ingestion/tasks.md S3~S5 ──
  app.openapi(R.registerRoute, notImplemented);
  app.openapi(R.loginRoute, notImplemented);
  app.openapi(R.meRoute, notImplemented);
  app.openapi(R.createExpertRoute, notImplemented);
  app.openapi(R.listExpertsRoute, notImplemented);
  app.openapi(R.getExpertRoute, notImplemented);
  app.openapi(R.createMaterialRoute, notImplemented);
  app.openapi(R.listMaterialsRoute, notImplemented);
  app.openapi(R.buildRoute, notImplemented);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "AI 专家平台 · 公开 API",
      version: "0.0.1",
      description:
        "前端唯一的 API 面。agent 服务只在内网可达，不出现在这份契约里。",
    },
  });

  return app;
}
