import type { MiddlewareHandler } from "hono";
import { verifyAccessToken, type AuthClaims } from "../core/jwt.js";
import { assertSessionActive } from "../services/session.js";
import { unauthorized } from "../core/errors.js";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthClaims;
  }
}

/**
 * 解析并校验 access token。
 *
 * 【为什么验签之外还要查一次库】
 *   JWT 是无状态的：签发出去就作废不了。如果只验签名，用户点了"登出所有设备"、
 *   或者我们检测到 refresh token 被盗并吊销了会话族，攻击者手上那个还没过期的
 *   access token 依然畅通无阻。
 *
 *   代价是每个受保护请求多一次主键查询 —— 这些请求本来就要读库，
 *   多这一次可以忽略。真成为瓶颈时再加进程内 5 秒 TTL 缓存。
 *
 * ⚠️ 租户 ID 只能从这里来。任何路由都不允许从请求体/查询参数读 tenantId ——
 *    那等于让客户端自己声明它是谁。
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized();

  const claims = await verifyAccessToken(header.slice(7));
  if (!claims) throw unauthorized();

  await assertSessionActive(claims.sid);

  c.set("auth", claims);
  await next();
};
