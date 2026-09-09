import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";

/**
 * B3：跨租户隔离在【真实业务链路】里生效 —— 这是 M0 的 RLS 测试的下一层证明。
 * M0 证明了"数据库会挡住"，这里证明"业务接口确实走在被挡住的那条路上"。
 * B6：内容去重。
 */

const app = createApp();
const uniq = () => `e${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
  });

const json = async (res: Response) => (await res.json()) as any;

async function creator() {
  const res = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: uniq(), password: "pass12345678" }),
  });
  return (await json(res)).data.accessToken as string;
}

async function makeExpert(token: string, name = "理财专家") {
  const res = await call("/api/experts", { method: "POST", token, body: JSON.stringify({ name }) });
  return (await json(res)).data.id as string;
}

const ARTICLE = `# 基金定投的三个常见误区

很多人以为定投就是无脑买入，其实不然。

## 误区一：只看历史收益

历史收益高不代表未来表现好。选基金要看基金经理的投资框架是否稳定。

## 误区二：忽略手续费

申购费、管理费、赎回费加起来会侵蚀相当一部分收益。长期持有能免赎回费。

## 误区三：涨了就停

定投的价值恰恰在于长期坚持，在下跌时积累更多份额。`;

beforeAll(async () => {
  const body = await json(await app.request("/readyz"));
  if (body.data.database !== "ok") throw new Error("数据库不可达 —— 先 `make up && make migrate`");
});
afterAll(async () => { await closeDb(); });

describe("专家与素材", () => {
  it("创建专家后能在列表和详情里查到", async () => {
    const token = await creator();
    const id = await makeExpert(token, "定投老王");

    const list = (await json(await call("/api/experts", { token }))).data;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("定投老王");
    expect(list[0].status).toBe("building");

    const detail = (await json(await call(`/api/experts/${id}`, { token }))).data;
    expect(detail.id).toBe(id);
    expect(detail.materialCount).toBe(0);
    expect(detail.lastBuild).toBeNull(); // 还没构建过
  });

  // ★ B3
  it("博主 A 访问博主 B 的专家返回 404（不是 403，不泄露资源是否存在）", async () => {
    const a = await creator();
    const b = await creator();
    const expertOfB = await makeExpert(b, "B 的专家");

    const res = await call(`/api/experts/${expertOfB}`, { token: a });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe(1404);

    // 列表里也看不到
    expect((await json(await call("/api/experts", { token: a }))).data).toHaveLength(0);
  });

  it("博主 A 不能往博主 B 的专家里塞素材", async () => {
    const a = await creator();
    const b = await creator();
    const expertOfB = await makeExpert(b, "B 的专家");

    const res = await call(`/api/experts/${expertOfB}/materials`, {
      method: "POST",
      token: a,
      body: JSON.stringify({ sourceType: "paste", title: "投毒", content: ARTICLE }),
    });
    expect(res.status).toBe(404);

    expect((await json(await call(`/api/experts/${expertOfB}/materials`, { token: b }))).data)
      .toHaveLength(0);
  });

  it("粘贴正文能落库，字数与哈希正确", async () => {
    const token = await creator();
    const id = await makeExpert(token);

    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST",
      token,
      body: JSON.stringify({ sourceType: "paste", title: "定投误区", content: ARTICLE }),
    });
    expect(res.status).toBe(200);

    const { material, deduplicated } = (await json(res)).data;
    expect(deduplicated).toBe(false);
    expect(material.title).toBe("定投误区");
    expect(material.charCount).toBe(ARTICLE.length);
    expect(material.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(material.chunkCount).toBe(0); // 还没构建

    const detail = (await json(await call(`/api/experts/${id}`, { token }))).data;
    expect(detail.materialCount).toBe(1);
  });

  // ★ B6
  it("同一内容重复上传时复用已有素材，不产生第二条", async () => {
    const token = await creator();
    const id = await makeExpert(token);
    const body = JSON.stringify({ sourceType: "paste", title: "定投误区", content: ARTICLE });

    const first = (await json(await call(`/api/experts/${id}/materials`, { method: "POST", token, body }))).data;
    const second = (await json(await call(`/api/experts/${id}/materials`, { method: "POST", token, body }))).data;

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.material.id).toBe(first.material.id);

    expect((await json(await call(`/api/experts/${id}/materials`, { token }))).data).toHaveLength(1);
  });

  it("超长素材在上传阶段就被拒（成本护栏前移）", async () => {
    const token = await creator();
    const id = await makeExpert(token);
    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST",
      token,
      body: JSON.stringify({ sourceType: "paste", title: "巨长", content: "字".repeat(100_001) }),
    });
    expect(res.status).toBe(400);
  });

  it("sourceType 与字段组合不匹配时被 schema 拒绝", async () => {
    const token = await creator();
    const id = await makeExpert(token);
    // url 类型却传 content
    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST",
      token,
      body: JSON.stringify({ sourceType: "url", title: "x", content: ARTICLE }),
    });
    expect(res.status).toBe(400);
  });

  it("不存在的专家 id 返回 404", async () => {
    const token = await creator();
    const res = await call("/api/experts/00000000-0000-4000-8000-000000000000", { token });
    expect(res.status).toBe(404);
  });
});
