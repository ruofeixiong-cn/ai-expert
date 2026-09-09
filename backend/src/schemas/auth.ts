import { z } from "@hono/zod-openapi";

export const RegisterInput = z
  .object({
    // 邮箱和手机号至少给一个
    email: z.string().email().optional(),
    phone: z.string().min(6).max(20).optional(),
    password: z.string().min(8).max(72).openapi({ description: "至少 8 位" }),
    nickname: z.string().min(1).max(40).optional(),
  })
  .refine((v) => Boolean(v.email || v.phone), {
    message: "邮箱和手机号至少填一个",
  })
  .openapi("RegisterInput");

export const LoginInput = z
  .object({
    account: z.string().min(1).openapi({ description: "邮箱或手机号" }),
    password: z.string().min(1),
  })
  .openapi("LoginInput");

export const UserPublic = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    nickname: z.string().nullable(),
    role: z.enum(["creator", "user"]),
  })
  .openapi("UserPublic");

export const TenantPublic = z
  .object({ id: z.string().uuid(), name: z.string() })
  .openapi("TenantPublic");

/**
 * ⚠️ 响应体里【只有 access token，没有 refresh token】。
 *
 * refresh token 通过 httpOnly + SameSite=Strict + Path=/api/auth 的 Cookie 下发，
 * JavaScript 读不到 —— 这样即使前端被 XSS，攻击者最多偷到一个 15 分钟就过期的
 * access token，偷不走那个能续命 30 天的凭据。
 *
 * 如果把 refresh token 放响应体，前端只能存 localStorage，XSS 一拿一个准，
 * 那整套轮换和重放检测就白做了。
 */
export const AuthResult = z
  .object({
    accessToken: z.string().openapi({ description: "放 Authorization: Bearer <token>，15 分钟有效" }),
    expiresIn: z.number().int().openapi({ example: 900, description: "access token 剩余秒数" }),
    user: UserPublic,
    tenant: TenantPublic,
  })
  .openapi("AuthResult");

export const RefreshResult = z
  .object({
    accessToken: z.string(),
    expiresIn: z.number().int().openapi({ example: 900 }),
  })
  .openapi("RefreshResult");

export const SessionInfo = z
  .object({
    id: z.string().uuid(),
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
    current: z.boolean().openapi({ description: "是否为当前这次登录" }),
    lastUsedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .openapi("SessionInfo");

export const RevokeResult = z
  .object({ revoked: z.number().int().openapi({ description: "被吊销的会话数" }) })
  .openapi("RevokeResult");

export const MeResult = z
  .object({ user: UserPublic, tenant: TenantPublic })
  .openapi("MeResult");
