import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { TTL } from "./tokens.js";
import { env } from "../env.js";

/**
 * refresh token 的 Cookie 设置。四个属性各自挡一类攻击：
 *
 *   httpOnly            JS 读不到 → XSS 偷不走这个长效凭据
 *   secure              只走 HTTPS → 中间人嗅探不到（dev 用 http，所以按环境开关）
 *   sameSite: "Strict"  跨站请求不带 Cookie → 刷新接口的 CSRF 基本被关死
 *   path: "/api/auth"   只有认证接口收得到 → 其他接口的日志/代理里不会意外留下它
 */
const NAME = "ae_rt";

const opts = () =>
  ({
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Strict",
    path: "/api/auth",
    maxAge: TTL.REFRESH_SECONDS,
  }) as const;

export const setRefreshCookie = (c: Context, token: string) => setCookie(c, NAME, token, opts());
export const readRefreshCookie = (c: Context) => getCookie(c, NAME) ?? null;
export const clearRefreshCookie = (c: Context) =>
  deleteCookie(c, NAME, { path: "/api/auth", secure: env.NODE_ENV === "production" });

export const clientMeta = (c: Context) => ({
  userAgent: c.req.header("user-agent") ?? null,
  ip:
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    null,
});


/**
 * 匿名粉丝身份的 Cookie。
 *
 * SameSite 用 Lax 而不是 Strict：分享链接是从微信/朋友圈【跨站点击】进来的，
 * Strict 会让第一次访问带不上 Cookie，粉丝每刷新一次就换一个身份，
 * 试聊额度形同虚设。
 */
const FAN = "ae_fan";

export const setFanCookie = (c: Context, token: string) =>
  setCookie(c, FAN, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/api/chat",
    maxAge: 180 * 24 * 3600,
  });

export const readFanCookie = (c: Context) => getCookie(c, FAN) ?? null;
