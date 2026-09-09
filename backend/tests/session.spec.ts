import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { LOGIN_THROTTLE } from "../src/core/tokens.js";

/**
 * Access / Refresh token 机制。
 * 重点是【重放检测】—— 这条是区分"有 refresh token"和"refresh token 做对了"的分水岭。
 */

const app = createApp();
const uniq = () => `s${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
const PW = "pass12345678";

/** 从 Set-Cookie 里抠出 refresh token（真实浏览器由 Cookie 罐自动管理）。 */
function readCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  const m = raw?.match(/ae_rt=([^;]*)/);
  const v = m?.[1];
  return v && v.length > 0 ? v : null;
}

const call = (path: string, init: RequestInit & { cookie?: string; token?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: `ae_rt=${init.cookie}` } : {}),
      ...(init.headers ?? {}),
    },
  });

async function signup() {
  const email = uniq();
  const res = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  const body = (await res.json()) as any;
  return { email, access: body.data.accessToken as string, refresh: readCookie(res)! };
}

beforeAll(async () => {
  const body = (await (await app.request("/readyz")).json()) as any;
  if (body.data.database !== "ok") throw new Error("数据库不可达 —— 先 `make up && make migrate`");
});
afterAll(async () => { await closeDb(); });

describe("Access / Refresh token", () => {
  it("注册即下发 refresh token，且只在 httpOnly Cookie 里，不出现在响应体", async () => {
    const res = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: uniq(), password: PW }),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/api/auth");

    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.expiresIn).toBe(900);
    // 长效凭据绝不能出现在 JS 读得到的地方
    expect(JSON.stringify(body)).not.toContain(readCookie(res));
  });

  it("能用 Cookie 里的 refresh token 换新 access token，并轮换出新的 refresh token", async () => {
    const { refresh } = await signup();
    const res = await call("/api/auth/refresh", { method: "POST", cookie: refresh });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBeTruthy();

    const rotated = readCookie(res);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(refresh); // 必须换新的，不能复用
  });

  it("刷新接口不接受请求体传入的 refresh token（否则 httpOnly 保护被绕开）", async () => {
    const { refresh } = await signup();
    const res = await call("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: refresh }),
    });
    expect(res.status).toBe(401);
  });

  it("★ 重放检测：旧 refresh token 被再次使用时，吊销整个会话族", async () => {
    const { refresh: t1, access } = await signup();

    // 正常轮换：t1 → t2
    const r1 = await call("/api/auth/refresh", { method: "POST", cookie: t1 });
    const t2 = readCookie(r1)!;
    expect(t2).toBeTruthy();

    // 攻击者拿着窃取到的 t1 再刷一次
    const replay = await call("/api/auth/refresh", { method: "POST", cookie: t1 });
    expect(replay.status).toBe(401);

    // 关键断言：不只是这次被拒 —— 合法用户手上的 t2 也必须失效，
    // 因为我们分不清谁是攻击者，只能两边都踢掉
    const afterBreach = await call("/api/auth/refresh", { method: "POST", cookie: t2 });
    expect(afterBreach.status).toBe(401);

    // 会话族被吊销后，还没过期的 access token 也应立即失效
    expect((await call("/api/me", { token: access })).status).toBe(401);
  });

  it("登出后，未过期的 access token 立即失效（无状态 token 的即时吊销）", async () => {
    const { access, refresh } = await signup();
    expect((await call("/api/me", { token: access })).status).toBe(200);

    const out = await call("/api/auth/logout", { method: "POST", token: access });
    expect(out.status).toBe(200);

    expect((await call("/api/me", { token: access })).status).toBe(401);
    expect((await call("/api/auth/refresh", { method: "POST", cookie: refresh })).status).toBe(401);
  });

  it("logout-all 吊销该账号的全部会话（两台设备同时掉线）", async () => {
    const email = uniq();
    await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: PW }) });

    const dev = async () => {
      const r = await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: email, password: PW }),
      });
      return { access: ((await r.json()) as any).data.accessToken as string };
    };
    const a = await dev();
    const b = await dev();

    const res = await call("/api/auth/logout-all", { method: "POST", token: a.access });
    expect(((await res.json()) as any).data.revoked).toBeGreaterThanOrEqual(2);

    expect((await call("/api/me", { token: a.access })).status).toBe(401);
    expect((await call("/api/me", { token: b.access })).status).toBe(401);
  });

  it("会话列表能区分出当前设备", async () => {
    const email = uniq();
    await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: PW }) });
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: email, password: PW }),
    });
    const access = ((await login.json()) as any).data.accessToken;

    const list = ((await (await call("/api/auth/sessions", { token: access })).json()) as any).data;
    expect(list.length).toBe(2); // 注册一个 + 登录一个
    expect(list.filter((s: any) => s.current).length).toBe(1);
  });

  it("登录连续失败达到上限后触发节流（1429）", async () => {
    const email = uniq();
    await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: PW }) });

    let throttled = false;
    for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILURES + 2; i++) {
      const res = await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: email, password: "definitely-wrong" }),
      });
      if (res.status === 429) { throttled = true; break; }
    }
    expect(throttled).toBe(true);

    // 节流期内即使密码正确也进不去
    const correct = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: email, password: PW }),
    });
    expect(correct.status).toBe(429);
  });

  it("登录成功后清零失败计数", async () => {
    const email = uniq();
    await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: PW }) });

    for (let i = 0; i < 3; i++) {
      await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: email, password: "wrong" }),
      });
    }
    expect(
      (await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: email, password: PW }),
      })).status,
    ).toBe(200);
  });
});
