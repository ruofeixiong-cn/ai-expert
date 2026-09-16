import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { closeDb, tenantTx } from "../src/db/client.js";
import { experts, expertModelDrafts } from "../src/db/schema/index.js";

const app = createApp();
const uniq = () => `m${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
  });
const json = async (r: Response) => (await r.json()) as any;

async function setup(withDraft = true) {
  const reg = await json(await call("/api/auth/register", {
    method: "POST", body: JSON.stringify({ email: uniq(), password: "pass12345678" }),
  }));
  const token = reg.data.accessToken as string;
  const tenantId = reg.data.tenant.id as string;

  const id = (await json(await call("/api/experts", {
    method: "POST", token, body: JSON.stringify({ name: "测试专家" }),
  }))).data.id as string;

  if (withDraft) {
    // 直接塞一份草稿，绕开 agent —— 这里测的是 backend 的确认与上线逻辑
    await tenantTx(tenantId, (tx) =>
      tx.insert(expertModelDrafts).values({
        expertId: id,
        tenantId,
        chunkCount: 12,
        model: {
          persona: [{ content: "语气直接", confidence: 0.9, evidenceChunkIds: [] }],
          knowledge: [{ content: "懂基金", confidence: 0.9, evidenceChunkIds: [] }],
          beliefs: [{ content: "AI 猜的立场", confidence: 0.4, evidenceChunkIds: [] }],
          methodology: [{ content: "先看框架", confidence: 0.8, evidenceChunkIds: [] }],
          decisionRules: [],
          boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
          examples: [],
        },
      }),
    );
  }
  return { token, id, tenantId };
}

beforeAll(async () => {
  const body = await json(await app.request("/readyz"));
  if (body.data.database !== "ok") throw new Error("数据库不可达 —— 先 `make up && make migrate`");
});
afterAll(async () => { await closeDb(); });

describe("七维专家模型", () => {
  it("未确认任何维度时，confirmed 等于草稿（默认通过）", async () => {
    const { token, id } = await setup();
    const m = (await json(await call(`/api/experts/${id}/model`, { token }))).data;

    expect(m.draft).not.toBeNull();
    expect(m.chunkCount).toBe(12);
    expect(m.confirmedDimensions).toEqual([]);
    // 「默认通过」：没确认的维度直接用草稿的内容
    expect(m.confirmed.persona[0].content).toBe("语气直接");
  });

  // ★ C6
  it("确认一个维度只影响那一个维度，其余仍取草稿", async () => {
    const { token, id } = await setup();

    const res = await call(`/api/experts/${id}/model/beliefs`, {
      method: "PUT", token,
      body: JSON.stringify({
        items: [{ content: "我改过的立场", confidence: 1, evidenceChunkIds: [] }],
      }),
    });
    expect(res.status).toBe(200);

    const m = (await json(res)).data;
    expect(m.confirmedDimensions).toEqual(["beliefs"]);
    expect(m.confirmed.beliefs[0].content).toBe("我改过的立场");
    // 其余维度不受影响
    expect(m.confirmed.persona[0].content).toBe("语气直接");
    expect(m.confirmed.knowledge[0].content).toBe("懂基金");
    // 草稿本身不被修改 —— 「AI 说的」和「博主认过的」是两份数据
    expect(m.draft.beliefs[0].content).toBe("AI 猜的立场");
  });

  it("可以清空一个维度（博主认为 AI 全写错了）", async () => {
    const { token, id } = await setup();
    const m = (await json(await call(`/api/experts/${id}/model/beliefs`, {
      method: "PUT", token, body: JSON.stringify({ items: [] }),
    }))).data;
    expect(m.confirmed.beliefs).toEqual([]);
    expect(m.confirmedDimensions).toContain("beliefs");
  });

  it("维度与条目类型不匹配时被拒绝", async () => {
    const { token, id } = await setup();
    // 往 boundaries 塞一个普通条目：结构上像，语义上是垃圾，
    // 不拦的话要等到 M3 拼 prompt 时才炸
    const res = await call(`/api/experts/${id}/model/boundaries`, {
      method: "PUT", token,
      body: JSON.stringify({ items: [{ content: "没有 kind", confidence: 1, evidenceChunkIds: [] }] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("boundaries");
  });

  it("不存在的维度名返回 400", async () => {
    const { token, id } = await setup();
    expect((await call(`/api/experts/${id}/model/nonsense`, {
      method: "PUT", token, body: JSON.stringify({ items: [] }),
    })).status).toBe(400);
  });

  // ★ C7
  it("禁区为空时不允许上线，且说清楚为什么", async () => {
    const { token, id } = await setup();
    await call(`/api/experts/${id}/model/boundaries`, {
      method: "PUT", token, body: JSON.stringify({ items: [] }),
    });

    const res = await call(`/api/experts/${id}/publish`, { method: "POST", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("边界");
  });

  it("还没有草稿就上线，提示先构建", async () => {
    const { token, id } = await setup(false);
    const res = await call(`/api/experts/${id}/publish`, { method: "POST", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("构建");
  });

  // ★ C8
  it("上线生成短链，重复上线不改变它", async () => {
    const { token, id } = await setup();

    const first = (await json(await call(`/api/experts/${id}/publish`, { method: "POST", token }))).data;
    expect(first.shareSlug).toMatch(/^[\w-]{10}$/);
    expect(first.shareUrl).toContain(`/s/${first.shareSlug}`);

    const second = (await json(await call(`/api/experts/${id}/publish`, { method: "POST", token }))).data;
    // 粉丝手里的链接不能因为博主重新上线就失效
    expect(second.shareSlug).toBe(first.shareSlug);

    const detail = (await json(await call(`/api/experts/${id}`, { token }))).data;
    expect(detail.status).toBe("online");
    expect(detail.shareSlug).toBe(first.shareSlug);
    expect(detail.publishedAt).not.toBeNull();
  });

  it("上线即快照：之后改草稿不影响已发布的内容", async () => {
    const { token, id, tenantId } = await setup();
    await call(`/api/experts/${id}/publish`, { method: "POST", token });

    // 模拟博主重新生成七维，草稿被整行替换
    await tenantTx(tenantId, (tx) =>
      tx
        .update(expertModelDrafts)
        .set({
          model: {
            persona: [{ content: "全新的草稿", confidence: 1, evidenceChunkIds: [] }],
            knowledge: [], beliefs: [], methodology: [], decisionRules: [],
            boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
            examples: [],
          },
        })
        .where(eq(expertModelDrafts.expertId, id)),
    );

    const [row] = await tenantTx(tenantId, (tx) =>
      tx.select({ published: experts.expertModel }).from(experts).where(eq(experts.id, id)).limit(1),
    );
    // 线上快照仍然是上线那一刻的内容 —— 否则重新生成会悄悄改变
    // 付费粉丝拿到的东西
    expect((row!.published as any).persona[0].content).toBe("语气直接");
  });

  // ★ F02 / F03 · ADR-003：条目来源
  //
  // 修复前：判定「AI 推断」只看证据是否为空，于是博主亲手加的条目被标成
  // "AI 推断的，你的原文里没有这句"；而「真实样本」要求证据 min(1)，
  // 博主手动加一条必然 400。两件事同一个根因 —— 契约里区分不了来源。
  describe("条目来源（origin）", () => {
    it("不带 origin 提交 → 缺省是 ai", async () => {
      const { token, id } = await setup();
      const m = (await json(await call(`/api/experts/${id}/model/beliefs`, {
        method: "PUT", token,
        body: JSON.stringify({ items: [{ content: "没写来源", confidence: 1, evidenceChunkIds: [] }] }),
      }))).data;

      expect(m.confirmed.beliefs[0].origin).toBe("ai");
    });

    it("博主手写的条目：证据为空也不算 AI 推断", async () => {
      const { token, id } = await setup();
      const m = (await json(await call(`/api/experts/${id}/model/decisionRules`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{ content: "我自己补的决策规则", confidence: 1, evidenceChunkIds: [], origin: "creator" }],
        }),
      }))).data;

      // 来源必须持久化 —— 存不住的话，刷新之后又会被指认成 AI 编造
      expect(m.confirmed.decisionRules[0].origin).toBe("creator");
      expect(m.confirmed.decisionRules[0].evidenceChunkIds).toEqual([]);
    });

    it("真实样本：博主手写的可以没有出处", async () => {
      const { token, id } = await setup();
      const res = await call(`/api/experts/${id}/model/examples`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{ question: "定投要不要择时", answer: "不要", evidenceChunkIds: [], origin: "creator" }],
        }),
      });

      expect(res.status).toBe(200);
      expect((await json(res)).data.confirmed.examples[0].origin).toBe("creator");
    });

    it("真实样本：AI 提炼的仍然必须带出处，不许编造", async () => {
      const { token, id } = await setup();
      const res = await call(`/api/experts/${id}/model/examples`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{ question: "AI 编的问", answer: "AI 编的答", evidenceChunkIds: [], origin: "ai" }],
        }),
      });

      expect(res.status).toBe(400);
      // 报错要说清是"出处"的问题，否则博主只会看到一句无从下手的格式错误
      expect((await json(res)).message).toContain("出处");
    });

    it("AI 提炼的样本带出处照常通过", async () => {
      const { token, id } = await setup();
      const res = await call(`/api/experts/${id}/model/examples`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{
            question: "定投的手续费怎么算",
            answer: "看费率",
            evidenceChunkIds: [randomUUID()],
            origin: "ai",
          }],
        }),
      });

      expect(res.status).toBe(200);
    });

    it("存量草稿没有这个字段，读出来不报错（缺省视为 ai）", async () => {
      // setup() 塞的草稿是旧结构，一个 origin 都没有 —— 线上已有的数据就长这样，
      // ADR-003 明确不做数据迁移，所以这条是回归保护：读路径不许因此炸掉。
      const { token, id } = await setup();
      const m = (await json(await call(`/api/experts/${id}/model`, { token }))).data;

      expect(m.draft.persona[0].origin).toBeUndefined();
      expect(m.confirmed.persona[0].content).toBe("语气直接");
    });
  });

  // ★ F01 后半截 · ADR-009：线上快照是否过期
  describe("有没有没推上线的改动", () => {
    // call() 的返回类型是 Response | Promise<Response>，不能直接 .then（tsc 会拒绝）
    const model = async (token: string, id: string) =>
      (await json(await call(`/api/experts/${id}/model`, { token }))).data;

    it("还没上线过时为 false —— 那时该提示的是「去上线」", async () => {
      const { token, id } = await setup();
      expect((await model(token, id)).hasUnpublishedChanges).toBe(false);
    });

    it("刚上线完，线上就是最新的", async () => {
      const { token, id } = await setup();
      await call(`/api/experts/${id}/publish`, { method: "POST", token });

      expect((await model(token, id)).hasUnpublishedChanges).toBe(false);
    });

    it("上线后改了内容 → true", async () => {
      const { token, id } = await setup();
      await call(`/api/experts/${id}/publish`, { method: "POST", token });

      await call(`/api/experts/${id}/model/beliefs`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{ content: "上线之后我又改了", confidence: 1, evidenceChunkIds: [], origin: "creator" }],
        }),
      });

      expect((await model(token, id)).hasUnpublishedChanges).toBe(true);
    });

    it("再点一次上线，提示消失", async () => {
      const { token, id } = await setup();
      await call(`/api/experts/${id}/publish`, { method: "POST", token });
      await call(`/api/experts/${id}/model/beliefs`, {
        method: "PUT", token,
        body: JSON.stringify({
          items: [{ content: "改了一次", confidence: 1, evidenceChunkIds: [], origin: "creator" }],
        }),
      });
      expect((await model(token, id)).hasUnpublishedChanges).toBe(true);

      await call(`/api/experts/${id}/publish`, { method: "POST", token });
      expect((await model(token, id)).hasUnpublishedChanges).toBe(false);
    });

    it("重新生成的草稿进入有效模型 → true（时间戳比不出来的那一半）", async () => {
      const { token, id, tenantId } = await setup();
      await call(`/api/experts/${id}/publish`, { method: "POST", token });

      // 未确认的维度按「默认通过」用草稿，所以草稿一变，线上快照就旧了
      await tenantTx(tenantId, (tx) =>
        tx
          .update(expertModelDrafts)
          .set({
            model: {
              persona: [{ content: "重新生成后的说法", confidence: 1, evidenceChunkIds: [] }],
              knowledge: [], beliefs: [], methodology: [], decisionRules: [],
              boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
              examples: [],
            },
          })
          .where(eq(expertModelDrafts.expertId, id)),
      );

      expect((await model(token, id)).hasUnpublishedChanges).toBe(true);
    });
  });

  // ★ C9
  it("跨租户读取 / 确认 / 上线他人的专家都返回 404", async () => {
    const { id } = await setup();
    const other = await setup(false);

    expect((await call(`/api/experts/${id}/model`, { token: other.token })).status).toBe(404);
    expect((await call(`/api/experts/${id}/model/beliefs`, {
      method: "PUT", token: other.token, body: JSON.stringify({ items: [] }),
    })).status).toBe(404);
    expect((await call(`/api/experts/${id}/publish`, {
      method: "POST", token: other.token,
    })).status).toBe(404);
  });
});
