import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";

/** B1 / B2：注册建租户、未登录拦截。 */

const app = createApp();
const uniq = () => `t${Date.now()}${Math.floor(Math.random() * 1e4)}@example.com`;

const post = (path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, token?: string) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  const res = await app.request("/readyz");
  const body = (await res.json()) as { data: { database: string } };
  if (body.data.database !== "ok") {
    throw new Error("数据库不可达 —— 请先 `make up && make migrate`");
  }
});

afterAll(async () => { await closeDb(); });

describe("认证", () => {
  // B1
  it("注册博主时自动创建租户，二者关联正确", async () => {
    const email = uniq();
    const res = await post("/api/auth/register", { email, password: "pass12345678", nickname: "老王" });
    expect(res.status).toBe(200);

    const { code, data } = (await res.json()) as any;
    expect(code).toBe(0);
    expect(data.user.role).toBe("creator");
    expect(data.tenant.id).toBeTruthy();

    // token 里的 tenantId 必须就是刚建的租户 —— 否则后续所有 RLS 都会指向错的租户
    const me = await get("/api/me", data.token);
    const meBody = (await me.json()) as any;
    expect(meBody.data.tenant.id).toBe(data.tenant.id);
    expect(meBody.data.user.id).toBe(data.user.id);
  });

  it("重复注册同一邮箱返回 1409", async () => {
    const email = uniq();
    await post("/api/auth/register", { email, password: "pass12345678" });
    const res = await post("/api/auth/register", { email, password: "pass12345678" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe(1409);
  });

  it("账号不存在与密码错误返回完全相同的响应（不泄露账号是否注册过）", async () => {
    const email = uniq();
    await post("/api/auth/register", { email, password: "pass12345678" });

    const wrongPw = await post("/api/auth/login", { account: email, password: "wrongpassword" });
    const noUser = await post("/api/auth/login", { account: uniq(), password: "wrongpassword" });

    expect(wrongPw.status).toBe(noUser.status);
    expect(await wrongPw.json()).toEqual(await noUser.json());
  });

  // B2
  it("未带 token 访问受保护接口返回 1401", async () => {
    for (const path of ["/api/me", "/api/experts"]) {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).code).toBe(1401);
    }
  });

  it("伪造 / 过期 token 同样被拒", async () => {
    const res = await get("/api/me", "eyJhbGciOiJIUzI1NiJ9.forged.signature");
    expect(res.status).toBe(401);
  });

  it("注册参数不合法返回 400（密码过短、邮箱手机号都不给）", async () => {
    expect((await post("/api/auth/register", { email: uniq(), password: "short" })).status).toBe(400);
    expect((await post("/api/auth/register", { password: "pass12345678" })).status).toBe(400);
  });
});
