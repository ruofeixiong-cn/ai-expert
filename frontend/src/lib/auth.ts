/**
 * 认证状态。
 *
 * access token【只存内存】—— 不进 localStorage。
 * 它 15 分钟就过期，刷新页面时用 httpOnly Cookie 里的 refresh token
 * 重新换一个即可（见 restoreSession）。存 localStorage 只会多一个 XSS 靶子。
 *
 * refresh token 前端完全不接触：它在 httpOnly Cookie 里，JS 读不到也不该读。
 */

let accessToken: string | null = null;
const listeners = new Set<() => void>();

export const getAccessToken = () => accessToken;

export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * ★ 并发刷新必须合并成一次。
 *
 * 页面通常会同时发好几个请求。如果 access token 刚好过期，它们会同时收到 401，
 * 于是同时去 POST /refresh。而服务端【每次刷新都会轮换 refresh token】：
 * 第一个请求把旧 token 换掉了，第二个请求带着已作废的旧 token 过来 ——
 * 服务端判定为【重放攻击】，直接吊销整个会话族，用户当场被踢下线。
 *
 * 症状是"功能测试全过，一到真实页面就随机掉线"，极难排查。
 * 解法就是这个 in-flight Promise：同一时刻只允许一个刷新在飞。
 */
let inFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include", // 带上 httpOnly Cookie
      });
      if (!res.ok) {
        setAccessToken(null);
        return null;
      }
      const body = (await res.json()) as { data: { accessToken: string } };
      setAccessToken(body.data.accessToken);
      return body.data.accessToken;
    } catch {
      setAccessToken(null);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 应用启动 / 刷新页面时恢复登录态。内存里的 token 已经没了，用 Cookie 换一个。 */
export const restoreSession = () => refreshAccessToken();

export async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  } finally {
    setAccessToken(null);
  }
}
