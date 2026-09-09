import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALG = "HS256";

export type AuthClaims = {
  userId: string;
  tenantId: string;
  role: "creator" | "user";
};

export async function signToken(claims: AuthClaims): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId, role: claims.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function verifyToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    if (!payload.sub || typeof payload.tenantId !== "string") return null;
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role === "creator" ? "creator" : "user",
    };
  } catch {
    return null;
  }
}
