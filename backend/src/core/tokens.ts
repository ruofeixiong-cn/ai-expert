import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** 各种有效期集中在这里，别散落到业务代码里。 */
export const TTL = {
  /** Access token 短命是整套设计的前提：它无状态，签发后无法单独作废。 */
  ACCESS_SECONDS: 15 * 60,
  REFRESH_SECONDS: 30 * 24 * 3600,
  /** 会话绝对上限。刷新只能续 refresh token，不能突破这条线。 */
  SESSION_ABSOLUTE_SECONDS: 90 * 24 * 3600,
} as const;

export const LOGIN_THROTTLE = {
  WINDOW_SECONDS: 15 * 60,
  MAX_FAILURES: 10,
} as const;

/**
 * 生成不透明的 refresh token：256 位随机。
 *
 * 为什么不用 JWT 做 refresh token：
 *   JWT 的卖点是无状态自验证，但 refresh token 必须能被吊销和轮换，
 *   那就一定要有服务端状态。既然要查库，JWT 那层签名就是纯开销，
 *   还多暴露了 payload 信息。不透明随机串更简单也更安全。
 */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 存储用哈希。
 *
 * 为什么是 sha256 而不是 argon2：
 *   慢哈希是为了对抗【低熵】口令的离线爆破 —— 用户密码只有几十位熵。
 *   这里是 256 位密码学随机数，本身就不可爆破，用慢哈希只会让每次
 *   刷新都白白多花几十毫秒。选对工具，不是越慢越安全。
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 常数时间比较，避免通过响应时间侧信道逐字节猜 token。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);
