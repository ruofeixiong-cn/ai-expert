import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, refreshAccessToken, setAccessToken } from "./auth";

/**
 * refresh 的两层并发保护：
 *   - 同一个标签页：单飞，多个 401 合并成一次刷新（M1）
 *   - 多个标签页：服务端宽限期内回 409，这里稍候重试（B03 的前端一半）
 */

const reply = (status: number, accessToken?: string) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => ({ code: status === 200 ? 0 : status, message: "", data: { accessToken } }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe("refreshAccessToken", () => {
  it("同一个标签页里的并发刷新合并成一次", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, "t1"));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

    expect([a, b]).toEqual(["t1", "t1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("409（另一个标签页刚刷新过）：稍候重试，不当成掉线", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(409))
      .mockResolvedValueOnce(reply(200, "new-token"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await pending).toBe("new-token");
    expect(getAccessToken()).toBe("new-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("一直 409：重试两次后放弃", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(reply(409));
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(5000);

    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("401：不重试，直接当成掉线", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(401));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("old");

    expect(await refreshAccessToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
