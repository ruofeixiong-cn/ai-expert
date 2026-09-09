import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { systemTx, type Tx } from "../db/client.js";
import { authSessions, refreshTokens, loginAttempts, users } from "../db/schema/index.js";
import { signAccessToken } from "../core/jwt.js";
import {
  TTL, LOGIN_THROTTLE, newRefreshToken, hashToken, secondsFromNow,
} from "../core/tokens.js";
import { unauthorized, AppError, Code } from "../core/errors.js";

export type ClientMeta = { userAgent: string | null; ip: string | null };

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
};

/** 在已有事务里签发一对 token 并落库。 */
async function issue(
  tx: Tx,
  sessionId: string,
  userId: string,
  tenantId: string,
  role: "creator" | "user",
): Promise<TokenPair> {
  const refresh = newRefreshToken();
  const [row] = await tx
    .insert(refreshTokens)
    .values({
      sessionId,
      tokenHash: hashToken(refresh),
      expiresAt: secondsFromNow(TTL.REFRESH_SECONDS),
    })
    .returning({ id: refreshTokens.id });
  if (!row) throw new AppError(Code.INTERNAL, "签发 refresh token 失败", 500);

  return {
    accessToken: await signAccessToken({ userId, tenantId, role, sid: sessionId }),
    refreshToken: refresh,
    accessExpiresIn: TTL.ACCESS_SECONDS,
  };
}

/** 登录成功后开一个新会话族。 */
export async function createSession(
  userId: string,
  tenantId: string,
  role: "creator" | "user",
  meta: ClientMeta,
): Promise<TokenPair> {
  return systemTx(async (tx) => {
    const [session] = await tx
      .insert(authSessions)
      .values({
        userId,
        tenantId,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        ip: meta.ip,
        absoluteExpiresAt: secondsFromNow(TTL.SESSION_ABSOLUTE_SECONDS),
      })
      .returning();
    if (!session) throw new AppError(Code.INTERNAL, "创建会话失败", 500);
    return issue(tx, session.id, userId, tenantId, role);
  });
}

/**
 * 用 refresh token 换一对新的。这是整套机制里最关键的一段。
 *
 * 三种情况：
 *   1. token 不存在        → 拒绝（可能是伪造，也可能是早已清理的旧记录）
 *   2. token 存在但已用过  → 【重放】。说明这个 token 被复制走了 ——
 *                            合法客户端在轮换后就丢弃了旧 token，不会再用。
 *                            此时不能只拒绝这一次，必须【吊销整个会话族】：
 *                            我们分不清眼前这个请求是攻击者还是真用户，
 *                            所以两边都踢掉，逼真用户重新登录。
 *   3. token 有效          → 标记已用、签发新的、指向新记录（形成链，便于审计）
 */
export async function rotate(presented: string, meta: ClientMeta): Promise<TokenPair> {
  /**
   * ⚠️ 这里刻意【不在事务内 throw】。
   *
   * 第一版写成了「update set revoked_at → throw」，看起来没问题，实际上
   * throw 会让整个事务回滚，把刚写下的吊销一起撤销 —— 结果是这次请求被拒了，
   * 但会话族根本没被吊销，被盗的凭据下一次照样能用。测试抓到的就是这个。
   *
   * 所以：事务里只做判定并返回结果，副作用（吊销）和抛错都在事务【外面】做。
   */
  type Outcome =
    | { kind: "ok"; pair: TokenPair }
    | { kind: "invalid" }
    | { kind: "reuse"; sessionId: string; userId: string }
    | { kind: "expired"; sessionId: string };

  const outcome: Outcome = await systemTx(async (tx) => {
    const hash = hashToken(presented);
    const [token] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    if (!token) return { kind: "invalid" };

    const [session] = await tx
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, token.sessionId))
      .limit(1);
    if (!session) return { kind: "invalid" };

    // ── 重放：这个 token 已经被用过了 ──
    // 合法客户端轮换后就丢弃旧 token，绝不会再用。所以它再次出现只能是
    // 被人复制走了。我们分不清眼前这个请求是攻击者还是真用户 ——
    // 只能把整族踢掉，逼真用户重新登录。
    if (token.usedAt !== null) {
      return { kind: "reuse", sessionId: session.id, userId: session.userId };
    }

    if (session.revokedAt !== null) return { kind: "invalid" };
    if (session.absoluteExpiresAt <= new Date()) return { kind: "expired", sessionId: session.id };
    if (token.expiresAt <= new Date()) return { kind: "invalid" };

    // ── 正常轮换 ──
    // 角色【每次刷新时重新读】而不是缓存在会话里：这样把某个用户降权后，
    // 最迟一个 access token 周期（15 分钟）就自动生效，不必强制他重新登录。
    const [u] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const role = u?.role === "creator" ? ("creator" as const) : ("user" as const);

    const pair = await issue(tx, session.id, session.userId, session.tenantId, role);

    const [replacement] = await tx
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(pair.refreshToken)))
      .limit(1);

    await tx
      .update(refreshTokens)
      .set({ usedAt: new Date(), replacedById: replacement?.id ?? null })
      .where(eq(refreshTokens.id, token.id));

    await tx
      .update(authSessions)
      .set({ lastUsedAt: new Date(), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) ?? null })
      .where(eq(authSessions.id, session.id));

    return { kind: "ok", pair };
  });

  switch (outcome.kind) {
    case "ok":
      return outcome.pair;
    case "reuse":
      // 独立事务，确保吊销真正落库
      await revokeSession(outcome.sessionId, "reuse_detected");
      console.warn(
        `[security] refresh token 重放，已吊销会话族 session=${outcome.sessionId} ` +
          `user=${outcome.userId} ip=${meta.ip ?? "-"}`,
      );
      throw unauthorized("检测到异常登录活动，请重新登录");
    case "expired":
      await revokeSession(outcome.sessionId, "expired");
      throw unauthorized("登录已超过最长有效期，请重新登录");
    default:
      throw unauthorized("登录已失效，请重新登录");
  }
}

/** 中间件用：会话是否仍然有效。access token 无状态，靠这一步实现即时吊销。 */
export async function assertSessionActive(sid: string): Promise<void> {
  const [session] = await systemTx((tx) =>
    tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, sid),
          isNull(authSessions.revokedAt),
          gt(authSessions.absoluteExpiresAt, new Date()),
        ),
      )
      .limit(1),
  );
  if (!session) throw unauthorized("登录已失效，请重新登录");
}

export async function revokeSession(sid: string, reason = "logout"): Promise<void> {
  await systemTx((tx) =>
    tx
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt))),
  );
}

/** 登出所有设备。改密码、发现异常时都该调这个。 */
export async function revokeAllSessions(userId: string, reason = "logout_all"): Promise<number> {
  const rows = await systemTx((tx) =>
    tx
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id }),
  );
  return rows.length;
}

export async function listSessions(userId: string, currentSid: string) {
  const rows = await systemTx((tx) =>
    tx
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          gt(authSessions.absoluteExpiresAt, new Date()),
        ),
      )
      .orderBy(desc(authSessions.lastUsedAt)),
  );
  return rows.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ip: s.ip,
    current: s.id === currentSid,
    lastUsedAt: s.lastUsedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  }));
}

// ─── 登录爆破节流 ──────────────────────────────────────────────────────────

/** 失败次数超限则拒绝。按 IP 和账号两个维度分别限，防止换 IP 或换账号绕过。 */
export async function assertNotThrottled(keys: string[]): Promise<void> {
  const since = new Date(Date.now() - LOGIN_THROTTLE.WINDOW_SECONDS * 1000);
  for (const key of keys) {
    const [row] = await systemTx((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(loginAttempts)
        .where(and(eq(loginAttempts.key, key), gt(loginAttempts.attemptedAt, since))),
    );
    if ((row?.n ?? 0) >= LOGIN_THROTTLE.MAX_FAILURES) {
      throw new AppError(Code.RATE_LIMITED, "登录尝试过于频繁，请稍后再试", 429);
    }
  }
}

export async function recordLoginFailure(keys: string[]): Promise<void> {
  await systemTx(async (tx) => {
    await tx.insert(loginAttempts).values(keys.map((key) => ({ key })));
    // 顺手清理过期记录，省得再开一个定时任务
    await tx
      .delete(loginAttempts)
      .where(lt(loginAttempts.attemptedAt, new Date(Date.now() - LOGIN_THROTTLE.WINDOW_SECONDS * 2000)));
  });
}

export async function clearLoginFailures(keys: string[]): Promise<void> {
  await systemTx(async (tx) => {
    for (const key of keys) await tx.delete(loginAttempts).where(eq(loginAttempts.key, key));
  });
}
