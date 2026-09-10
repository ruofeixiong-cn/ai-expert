import { hash, verify } from "@node-rs/argon2";
import { eq, or } from "drizzle-orm";
import { systemTx } from "../db/client.js";
import { users, tenants } from "../db/schema/index.js";
import { badRequest, conflict, unauthorized } from "../core/errors.js";
import {
  createSession, assertNotThrottled, recordLoginFailure, clearLoginFailures,
  type ClientMeta, type TokenPair,
} from "./session.js";
import type { z } from "@hono/zod-openapi";
import type { RegisterInput, LoginInput } from "../schemas/auth.js";

const shape = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  phone: u.phone,
  nickname: u.nickname,
  role: u.role === "creator" ? ("creator" as const) : ("user" as const),
});

/**
 * 注册博主。
 *
 * users / tenants 都没有 RLS（注册发生在租户上下文之外），所以走 systemTx。
 * 两条插入必须在【同一个事务】里 —— 建了用户没建租户的话，
 * 这个账号永远登录不了（JWT 需要 tenantId），且没有任何提示。
 */
export async function register(input: z.infer<typeof RegisterInput>, meta: ClientMeta) {
  const { email = null, phone = null, password, nickname = null } = input;

  return systemTx(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          email ? eq(users.email, email) : undefined,
          phone ? eq(users.phone, phone) : undefined,
        ),
      )
      .limit(1);
    if (existing.length > 0) throw conflict("该邮箱或手机号已注册");

    const [user] = await tx
      .insert(users)
      .values({ email, phone, passwordHash: await hash(password), nickname, role: "creator" })
      .returning();
    if (!user) throw badRequest("创建用户失败");

    const [tenant] = await tx
      .insert(tenants)
      .values({ ownerUserId: user.id, name: nickname ?? email ?? phone ?? "我的空间" })
      .returning();
    if (!tenant) throw badRequest("创建租户失败");

    return { user: shape(user), tenant: { id: tenant.id, name: tenant.name } };
  }).then(async (r) => ({
    ...r,
    tokens: await createSession(r.user.id, r.tenant.id, "creator", meta),
  }));
}

export async function login(
  input: z.infer<typeof LoginInput>,
  meta: ClientMeta,
): Promise<{ user: ReturnType<typeof shape>; tenant: { id: string; name: string }; tokens: TokenPair }> {
  const { account, password } = input;
  // 两个维度分别限：只限 IP 则攻击者换 IP 绕过；只限账号则可以拿一个密码
  // 去撞一万个账号（credential stuffing）。
  const throttleKeys = [`account:${account}`, ...(meta.ip ? [`ip:${meta.ip}`] : [])];
  await assertNotThrottled(throttleKeys);

  // 事务里只读数据；argon2 校验和失败计数都放在事务外面：
  //   - 失败计数自己要开事务。第一版在 systemTx 里调它，一次登录失败同时占两个连接（B04），
  //     撞库时并发一高就把连接池耗死 —— db/client.ts 的嵌套检测上线后当场抓到的
  //   - argon2 故意很慢（几十毫秒），没必要在这段时间里占着数据库连接
  const found = await systemTx(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(or(eq(users.email, account), eq(users.phone, account)))
      .limit(1);
    if (!user) return null;

    const [tenant] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.ownerUserId, user.id))
      .limit(1);
    return { user, tenant };
  });

  // 账号不存在与密码错误返回同一个错误 —— 不泄露账号是否注册过
  if (!found?.user.passwordHash || !(await verify(found.user.passwordHash, password))) {
    await recordLoginFailure(throttleKeys);
    throw unauthorized("账号或密码不正确");
  }
  const { user, tenant } = found;
  if (!tenant) throw unauthorized("账号缺少关联租户，请联系支持");

  await clearLoginFailures(throttleKeys);
  const role = user.role === "creator" ? ("creator" as const) : ("user" as const);
  return {
    user: shape(user),
    tenant: { id: tenant.id, name: tenant.name },
    tokens: await createSession(user.id, tenant.id, role, meta),
  };
}

export async function me(userId: string, tenantId: string) {
  return systemTx(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!user || !tenant) throw unauthorized();
    return { user: shape(user), tenant: { id: tenant.id, name: tenant.name } };
  });
}
