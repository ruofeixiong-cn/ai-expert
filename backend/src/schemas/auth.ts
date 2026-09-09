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

export const AuthResult = z
  .object({
    token: z.string().openapi({ description: "JWT，放 Authorization: Bearer <token>" }),
    user: UserPublic,
    tenant: TenantPublic,
  })
  .openapi("AuthResult");

export const MeResult = z
  .object({ user: UserPublic, tenant: TenantPublic })
  .openapi("MeResult");
