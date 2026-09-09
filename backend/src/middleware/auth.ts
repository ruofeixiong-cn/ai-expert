import type { MiddlewareHandler } from "hono";
import { verifyToken, type AuthClaims } from "../core/jwt.js";
import { unauthorized } from "../core/errors.js";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthClaims;
  }
}

/**
 * 解析 JWT 并把身份放进 context。
 *
 * ⚠️ 租户 ID 只能从这里来。任何路由都不允许从请求体/查询参数读 tenantId ——
 * 那等于让客户端自己声明它是谁。
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized();

  const claims = await verifyToken(header.slice(7));
  if (!claims) throw unauthorized();

  c.set("auth", claims);
  await next();
};
