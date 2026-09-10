import { describe, it, expect, afterAll, vi } from "vitest";
import { closeDb } from "../src/db/client.js";
import { TTL } from "../src/core/tokens.js";
import { call as rawCall, json, uniqEmail } from "./helpers.js";

/**
 * refresh token 轮换：重放检测（M1）与并发（B03）。
 *
 * B03 的两个问题：
 *   1. 令牌链分叉：两个请求带着同一个 token 同时到达，都读到 used_at = null，
 *      都签发成功 → 两条都有效的令牌链。被盗的 token 只要抢在同一时刻用，
 *      就绕过了重放检测。
 *   2. 多标签页误杀：前端的单飞只在一个标签页内有效。浏览器重启时恢复的
 *      多个标签页同时刷新，后到的被判定为重放 → 整族吊销 → 用户被踢下线。
 */
afterAll(async () => { await closeDb(); });

const PW = "pass12345678";

function readCookie(res: Response): string | null {
  const m = res.headers.get("set-cookie")?.match(/ae_rt=([^;]*)/);
  return m?.[1] ? m[1] : null;
}

const refresh = (token: string) =>
  rawCall("/api/auth/refresh", { method: "POST", cookie: `ae_rt=${token}` });

async function signup() {
  const res = await rawCall("/api/auth/register", {
    method: "POST", body: JSON.stringify({ email: uniqEmail("r"), password: PW }),
  });
  return { access: (await json(res)).data.accessToken as string, refresh: readCookie(res)! };
}

describe("refresh 轮换", () => {
  it("★ 重放检测：超过宽限期后旧 token 再次出现，吊销整个会话族", async () => {
    const { refresh: t1, access } = await signup();
    const t2 = readCookie(await refresh(t1))!;
    expect(t2).toBeTruthy();

    // 宽限期内的「已用过」是良性并发（见下一条）；超过宽限期再出现，只能是被复制走了
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (TTL.REFRESH_REUSE_GRACE_SECONDS + 1) * 1000);
    try {
      expect((await refresh(t1)).status).toBe(401);
      // 分不清谁是攻击者，只能两边都踢：合法用户手上的 t2 也失效
      expect((await refresh(t2)).status).toBe(401);
      // 还没过期的 access token 也立即失效
      expect((await rawCall("/api/me", { token: access })).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ 同一个 token 并发刷新两次：只成功一个，不分叉，也不误杀会话", async () => {
    const { refresh: t1 } = await signup();

    const [a, b] = await Promise.all([refresh(t1), refresh(t1)]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    // 输的一方不能清 Cookie —— 同一个浏览器里，那会把赢家刚写下的新 token 一起删掉
    expect(loser.headers.get("set-cookie")).toBeNull();
    // 会话族没有被当成重放吊销：赢家的新 token 照常可用
    expect((await refresh(readCookie(winner)!)).status).toBe(200);
  });

  it("宽限期内再次使用：不签发新 token（不能靠抢时间窗口拿到第二条令牌链）", async () => {
    const { refresh: t1 } = await signup();
    expect((await refresh(t1)).status).toBe(200);

    const again = await refresh(t1);

    expect(again.status).toBe(409);
    expect(readCookie(again)).toBeNull();
  });
});
