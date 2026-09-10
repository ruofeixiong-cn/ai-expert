import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "./queryClient";
import { logout, setAccessToken } from "./auth";

/**
 * F06：退出登录不清查询缓存。
 *
 * QueryClient 是全局单例，登出只清了 token。同一台电脑换一个账号登录，
 * 专家列表在 staleTime 内直接显示上一个账号的缓存。
 */
describe("登录态与查询缓存", () => {
  afterEach(() => {
    setAccessToken(null);
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("登录态丢失时清空缓存", () => {
    setAccessToken("token-A");
    queryClient.setQueryData(["experts"], [{ id: "expert-of-A" }]);

    setAccessToken(null);

    expect(queryClient.getQueryData(["experts"])).toBeUndefined();
  });

  it("同一会话内刷新 token 不清缓存", () => {
    setAccessToken("token-A-1");
    queryClient.setQueryData(["experts"], [{ id: "expert-of-A" }]);

    setAccessToken("token-A-2");

    expect(queryClient.getQueryData(["experts"])).toEqual([{ id: "expert-of-A" }]);
  });

  it("登出请求失败（断网）也要清", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    setAccessToken("token-A");
    queryClient.setQueryData(["experts"], [{ id: "expert-of-A" }]);

    await logout().catch(() => {});

    expect(queryClient.getQueryData(["experts"])).toBeUndefined();
  });
});
