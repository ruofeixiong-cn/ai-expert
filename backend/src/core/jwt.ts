import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";
import { TTL } from "./tokens.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALG = "HS256";

export type AuthClaims = {
  userId: string;
  tenantId: string;
  role: "creator" | "user";
  /** 会话族 ID。中间件用它查会话是否已被吊销。 */
  sid: string;
};

/**
 * 签发 access token。15 分钟。
 *
 * 它是无状态的，签发后无法单独作废 —— 所以中间件除了验签，
 * 还会查一次会话是否已吊销（见 middleware/auth.ts）。短 TTL 是
 * 第二道保险：即使漏查，暴露窗口也只有 15 分钟。
 */
export async function signAccessToken(claims: AuthClaims): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId, role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${TTL.ACCESS_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    if (!payload.sub || typeof payload.tenantId !== "string" || typeof payload.sid !== "string") {
      return null;
    }
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role === "creator" ? "creator" : "user",
      sid: payload.sid,
    };
  } catch {
    return null;
  }
}
