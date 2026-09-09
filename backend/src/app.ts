import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { env } from "./env.js";
import { getDb } from "./db/client.js";
import { envelope, ok } from "./schemas/common.js";
import * as R from "./routes/definitions.js";
import { requireAuth } from "./middleware/auth.js";
import { AppError, Code, unauthorized } from "./core/errors.js";
import * as authSvc from "./services/auth.js";
import * as sessionSvc from "./services/session.js";
import {
  setRefreshCookie, readRefreshCookie, clearRefreshCookie, clientMeta,
} from "./core/cookies.js";

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

  // ── 需要登录的路径 ──
  app.use("/api/me", requireAuth);
  app.use("/api/auth/logout", requireAuth);
  app.use("/api/auth/logout-all", requireAuth);
  app.use("/api/auth/sessions", requireAuth);
  app.use("/api/experts", requireAuth);
  app.use("/api/experts/*", requireAuth);

  // ── 统一错误响应 {code, message, data:null} ──
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.appCode, message: err.message, data: null }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ code: err.status, message: err.message, data: null }, err.status);
    }
    console.error("[unhandled]", err);
    return c.json({ code: Code.INTERNAL, message: "服务内部错误", data: null }, 500);
  });

  // ── M1 接口：实现见 specs/002-m1-ingestion/tasks.md ──
  app.openapi(R.registerRoute, async (c) => {
    const r = await authSvc.register(c.req.valid("json"), clientMeta(c));
    setRefreshCookie(c, r.tokens.refreshToken);
    return c.json(
      ok({
        accessToken: r.tokens.accessToken,
        expiresIn: r.tokens.accessExpiresIn,
        user: r.user,
        tenant: r.tenant,
      }),
    );
  });

  app.openapi(R.loginRoute, async (c) => {
    const r = await authSvc.login(c.req.valid("json"), clientMeta(c));
    setRefreshCookie(c, r.tokens.refreshToken);
    return c.json(
      ok({
        accessToken: r.tokens.accessToken,
        expiresIn: r.tokens.accessExpiresIn,
        user: r.user,
        tenant: r.tenant,
      }),
    );
  });

  app.openapi(R.refreshRoute, async (c) => {
    // 只从 Cookie 读，不接受请求体传入 —— 否则 httpOnly 的保护就被绕开了
    const presented = readRefreshCookie(c);
    if (!presented) throw unauthorized("缺少刷新凭据，请重新登录");

    let pair;
    try {
      pair = await sessionSvc.rotate(presented, clientMeta(c));
    } catch (e) {
      // 刷新失败（含重放导致的整族吊销）必须清掉 Cookie，
      // 否则前端会拿着一个死 token 无限重试
      clearRefreshCookie(c);
      throw e;
    }
    setRefreshCookie(c, pair.refreshToken);
    return c.json(ok({ accessToken: pair.accessToken, expiresIn: pair.accessExpiresIn }));
  });

  app.openapi(R.logoutRoute, async (c) => {
    await sessionSvc.revokeSession(c.get("auth").sid, "logout");
    clearRefreshCookie(c);
    return c.json(ok({ revoked: 1 }));
  });

  app.openapi(R.logoutAllRoute, async (c) => {
    const revoked = await sessionSvc.revokeAllSessions(c.get("auth").userId, "logout_all");
    clearRefreshCookie(c);
    return c.json(ok({ revoked }));
  });

  app.openapi(R.sessionsRoute, async (c) => {
    const { userId, sid } = c.get("auth");
    return c.json(ok(await sessionSvc.listSessions(userId, sid)));
  });
  app.openapi(R.meRoute, async (c) => {
    const { userId, tenantId } = c.get("auth");
    return c.json(ok(await authSvc.me(userId, tenantId)));
  });
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
