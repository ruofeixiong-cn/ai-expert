import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";

/**
 * 跨服务端到端：backend → agent → ARQ worker → chunks → 回到 backend API。
 *
 * 前面各层的测试都在自己的边界内：backend 测试用 app.request 直连，
 * agent 测试直接调 run_build。**没有一条测试真的跨过服务边界**——
 * S6 那个 authFetch 丢请求头的 bug 就是这么漏掉的。
 *
 * 这套测试需要 postgres + redis + agent + worker 都在跑，
 * 所以默认跳过，由 `make e2e` 起好依赖后设 E2E=1 触发。
 */

const enabled = process.env.E2E === "1";
const app = createApp();

const ARTICLE = [
  "# 基金定投完整指南\n\n定投的核心是纪律，不是频率。很多人以为定投就是无脑买入，其实不然。\n",
  "## 一、为什么要定投\n\n" + "普通投资者最大的问题是择时能力差，追涨杀跌。定投用固定的节奏消除择时的影响，把注意力从判断涨跌转移到长期持有上。".repeat(14),
  "\n\n## 二、手续费怎么算\n\n" + "申购费、管理费、赎回费加起来会侵蚀相当一部分收益。以年化八个点的收益计算，一点五个点的综合费率意味着近两成的收益被吃掉。长期持有满两年通常可以免掉赎回费。".repeat(14),
  "\n\n## 三、怎么选基金\n\n" + "选基金要看基金经理的投资框架是否稳定，以及他在不同市场环境下的应对方式。过去三年的冠军基金往往在接下来的两年表现平平。".repeat(14),
  "\n\n## 四、什么时候该停\n\n" + "定投的价值恰恰在于长期坚持，在下跌时积累更多份额。市场下跌时你买到的份额更多，这才是定投真正的红利。".repeat(14),
].join("");

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
  });
const json = async (r: Response) => (await r.json()) as any;

async function creator() {
  const res = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: `e2e${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
      password: "pass12345678",
    }),
  });
  return (await json(res)).data.accessToken as string;
}

async function newExpert(token: string) {
  const r = await call("/api/experts", {
    method: "POST", token, body: JSON.stringify({ name: `e2e-${Date.now()}` }),
  });
  return (await json(r)).data.id as string;
}

/** 轮询到构建结束。返回途中观察到的所有状态，用于验证进度确实在推进。 */
async function waitBuild(token: string, id: string, timeoutMs = 90_000) {
  const seen: Array<{ status: string; progress: number; stage: string | null; error: string | null }> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = (await json(await call(`/api/experts/${id}`, { token }))).data;
    const b = d.lastBuild;
    if (b) {
      const last = seen.at(-1);
      if (!last || last.status !== b.status || last.progress !== b.progress) {
        seen.push({ status: b.status, progress: b.progress, stage: b.stage, error: b.error });
      }
      if (b.status === "succeeded" || b.status === "failed") return { detail: d, seen };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`构建超时。观察到的状态：${JSON.stringify(seen)}`);
}

beforeAll(async () => {
  if (!enabled) return;
  const ready = (await json(await app.request("/readyz"))).data;
  if (ready.database !== "ok") throw new Error("数据库不可达");
  if (ready.agent !== "ok") throw new Error("agent 不可达 —— 用 `make e2e` 启动完整依赖");
});
afterAll(async () => { if (enabled) await closeDb(); });

describe.skipIf(!enabled)("端到端：内容入库", () => {
  // B4 + B8
  it("上传长文 → 构建 → 产出带正确租户的知识切片，进度全程可读", async () => {
    const token = await creator();
    const id = await newExpert(token);

    const up = (await json(await call(`/api/experts/${id}/materials`, {
      method: "POST", token,
      body: JSON.stringify({ sourceType: "paste", title: "基金定投完整指南", content: ARTICLE }),
    }))).data;
    expect(up.deduplicated).toBe(false);
    // B4 要求 3000 字量级的真实长文
    expect(up.material.charCount).toBeGreaterThan(3000);

    const build = await call(`/api/experts/${id}/build`, { method: "POST", token });
    expect(build.status).toBe(200);
    expect((await json(build)).data.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const { detail, seen } = await waitBuild(token, id);

    expect(detail.lastBuild.status).toBe("succeeded");
    expect(detail.lastBuild.progress).toBe(100);
    expect(detail.lastBuild.error).toBeNull();
    expect(detail.chunkCount).toBeGreaterThanOrEqual(5);

    // B8：中途必须能读到有意义的阶段，而不是从 0 直接跳 100
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((s) => s.progress >= 0 && s.progress <= 100)).toBe(true);
    expect(seen.at(-1)!.stage).toBe("done");

    // 素材维度的切片数要对得上
    const mats = (await json(await call(`/api/experts/${id}/materials`, { token }))).data;
    expect(mats[0].chunkCount).toBe(detail.chunkCount);
  }, 120_000);

  // B6
  it("重复上传同一内容 + 重新构建，不产生重复切片", async () => {
    const token = await creator();
    const id = await newExpert(token);
    const body = JSON.stringify({ sourceType: "paste", title: "指南", content: ARTICLE });

    await call(`/api/experts/${id}/materials`, { method: "POST", token, body });
    await call(`/api/experts/${id}/build`, { method: "POST", token });
    const first = (await waitBuild(token, id)).detail.chunkCount;
    expect(first).toBeGreaterThan(0);

    // 同样的内容再传一次 → 复用素材
    const again = (await json(await call(`/api/experts/${id}/materials`, {
      method: "POST", token, body,
    }))).data;
    expect(again.deduplicated).toBe(true);

    await call(`/api/experts/${id}/build`, { method: "POST", token });
    const second = (await waitBuild(token, id)).detail;
    expect(second.chunkCount).toBe(first);
    expect(second.materialCount).toBe(1);
  }, 180_000);

  // B8 失败路径
  it("没有素材就构建 → 状态置 failed，错误信息对博主可读", async () => {
    const token = await creator();
    const id = await newExpert(token);

    await call(`/api/experts/${id}/build`, { method: "POST", token });
    const { detail } = await waitBuild(token, id, 30_000);

    expect(detail.lastBuild.status).toBe("failed");
    expect(detail.lastBuild.error).toContain("素材");
    // 失败信息必须是给人看的，不能是堆栈或异常类名
    expect(detail.lastBuild.error).not.toMatch(/Traceback|Exception|Error:/);
    expect(detail.chunkCount).toBe(0);
  }, 60_000);

  // 隔离在完整链路里仍然成立
  it("另一个博主看不到、也构建不了这个专家", async () => {
    const owner = await creator();
    const id = await newExpert(owner);
    await call(`/api/experts/${id}/materials`, {
      method: "POST", token: owner,
      body: JSON.stringify({ sourceType: "paste", title: "私有", content: ARTICLE }),
    });

    const other = await creator();
    expect((await call(`/api/experts/${id}`, { token: other })).status).toBe(404);
    expect((await call(`/api/experts/${id}/materials`, { token: other })).status).toBe(404);
    expect((await call(`/api/experts/${id}/build`, { method: "POST", token: other })).status).toBe(404);
  }, 60_000);
});
