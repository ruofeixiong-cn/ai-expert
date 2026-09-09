import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { closeDb, tenantTx } from "../src/db/client.js";
import { experts, expertModelDrafts, messages, conversations } from "../src/db/schema/index.js";
import { SseSniffer, teeStream } from "../src/services/sse.js";

const app = createApp();
const uniq = () => `c${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });
const json = async (r: Response) => (await r.json()) as any;

const MODEL = {
  persona: [{ content: "语气直接", confidence: 1, evidenceChunkIds: [] }],
  knowledge: [], beliefs: [], methodology: [], decisionRules: [],
  boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
  examples: [],
};

/** 造一个已上线的专家，返回它的短链。 */
async function publishedExpert(freeTrial = 3) {
  const reg = await json(await call("/api/auth/register", {
    method: "POST", body: JSON.stringify({ email: uniq(), password: "pass12345678" }),
  }));
  const token = reg.data.accessToken as string;
  const tenantId = reg.data.tenant.id as string;
  const id = (await json(await call("/api/experts", {
    method: "POST", token, body: JSON.stringify({ name: "定投老王" }),
  }))).data.id as string;

  await tenantTx(tenantId, (tx) =>
    tx.insert(expertModelDrafts).values({ expertId: id, tenantId, chunkCount: 5, model: MODEL }),
  );
  await tenantTx(tenantId, (tx) =>
    tx.update(experts).set({ freeTrialMessages: freeTrial }).where(eq(experts.id, id)),
  );
  const pub = (await json(await call(`/api/experts/${id}/publish`, { method: "POST", token }))).data;
  return { token, tenantId, id, slug: pub.shareSlug as string };
}

beforeAll(async () => {
  const body = await json(await app.request("/readyz"));
  if (body.data.database !== "ok") throw new Error("数据库不可达 —— 先 `make up && make migrate`");
});
afterAll(async () => { await closeDb(); });

describe("粉丝对话", () => {
  it("按短链拿到专家信息与试聊剩余，并下发匿名身份 Cookie", async () => {
    const { slug } = await publishedExpert(3);
    const res = await call(`/api/chat/${slug}`);
    expect(res.status).toBe(200);

    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("ae_fan=");
    expect(raw).toContain("HttpOnly");
    // 分享链接是跨站点击进来的，Strict 会让第一次访问带不上 Cookie
    expect(raw).toContain("SameSite=Lax");

    const d = (await json(res)).data;
    expect(d.name).toBe("定投老王");
    expect(d.trialRemaining).toBe(3);
  });

  // ★ D2
  it("未上线的专家，短链查不到（返回 404 而非 403）", async () => {
    const reg = await json(await call("/api/auth/register", {
      method: "POST", body: JSON.stringify({ email: uniq(), password: "pass12345678" }),
    }));
    const token = reg.data.accessToken as string;
    const id = (await json(await call("/api/experts", {
      method: "POST", token, body: JSON.stringify({ name: "未上线" }),
    }))).data.id as string;

    // 手动塞一个 slug 但不上线。slug 有唯一索引，所以每次跑要不一样 ——
    // 硬编码的话第二次跑就撞索引。
    const slug = `off${Date.now().toString(36).slice(-7)}`;
    await tenantTx(reg.data.tenant.id, (tx) =>
      tx.update(experts).set({ shareSlug: slug }).where(eq(experts.id, id)),
    );
    expect((await call(`/api/chat/${slug}`)).status).toBe(404);
  });

  it("不存在的短链同样返回 404，不泄露它是否存在过", async () => {
    const a = await call("/api/chat/zzzzzzzzzz");
    const b = await call("/api/chat/yyyyyyyyyy");
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await json(a)).toEqual(await json(b));
  });

  // ★ D8
  it("试聊额度用完时发 event: error + 402，而不是断流", async () => {
    const { slug, tenantId, id } = await publishedExpert(1);

    // 先拿到匿名身份
    const first = await call(`/api/chat/${slug}`);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const fanUserId = await fanUserOf(cookie);

    // 造一条已有的助手回答，把仅有的 1 次额度用掉
    const [conv] = await tenantTx(tenantId, (tx) =>
      tx.insert(conversations)
        .values({ tenantId, expertId: id, fanUserId })
        .returning({ id: conversations.id }),
    );
    await tenantTx(tenantId, (tx) =>
      tx.insert(messages).values({
        tenantId, conversationId: conv!.id, role: "assistant", content: "已经回答过一次",
      }),
    );

    const res = await call(`/api/chat/${slug}`, {
      method: "POST", cookie, body: JSON.stringify({ question: "再问一个" }),
    });
    // HTTP 仍然 200 —— 断流的话前端分不清「网络挂了」和「要付费」
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain('"code":402');
    expect(body).toContain("试聊次数已用完");
  });

  it("额度按【助手回答】计，只发问没收到回答不扣", async () => {
    const { slug, tenantId, id } = await publishedExpert(2);
    const first = await call(`/api/chat/${slug}`);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const fanUserId = await fanUserOf(cookie);

    const [conv] = await tenantTx(tenantId, (tx) =>
      tx.insert(conversations).values({ tenantId, expertId: id, fanUserId })
        .returning({ id: conversations.id }),
    );
    // 两条用户提问，零条回答
    await tenantTx(tenantId, (tx) =>
      tx.insert(messages).values([
        { tenantId, conversationId: conv!.id, role: "user", content: "问题一" },
        { tenantId, conversationId: conv!.id, role: "user", content: "问题二" },
      ]),
    );

    const d = (await json(await call(`/api/chat/${slug}`, { cookie }))).data;
    expect(d.trialRemaining).toBe(2);
  });

  it("提问内容为空被拒", async () => {
    const { slug } = await publishedExpert();
    const res = await call(`/api/chat/${slug}`, {
      method: "POST", body: JSON.stringify({ question: "" }),
    });
    expect(res.status).toBe(400);
  });
});

/** 从 Cookie 里解出匿名粉丝 id —— 测试要用它构造已有会话。 */
async function fanUserOf(cookie: string) {
  const { readFanToken } = await import("../src/services/chat.js");
  const token = cookie.replace("ae_fan=", "");
  const id = await readFanToken(token);
  if (!id) throw new Error("Cookie 里没有有效的粉丝身份");
  return id;
}

// ─── SSE 嗅探与结算 ──────────────────────────────────────────────────────────

describe("SSE 转发与嗅探", () => {
  const enc = new TextEncoder();
  const streamOf = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) { chunks.forEach((s) => c.enqueue(enc.encode(s))); c.close(); },
    });
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    let out = "";
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  };

  it("原样转发，同时解析出 meta 与 done", async () => {
    let seen: SseSniffer | null = null;
    const input = [
      'event: meta\ndata: {"message_id":"m1","confidence":0.42,"chunk_ids":["a","b"]}\n\n',
      'event: delta\ndata: {"text":"你好"}\n\n',
      'event: done\ndata: {"finish_reason":"stop","safety":"pass","answer":"你好"}\n\n',
    ];
    const out = await drain(
      teeStream(streamOf(input), new AbortController().signal, (s) => { seen = s; }),
    );
    expect(out).toBe(input.join("")); // 转发必须一字不改
    expect(seen!.meta?.chunk_ids).toEqual(["a", "b"]);
    expect(seen!.done?.answer).toBe("你好");
  });

  it("帧被网络切碎也能正确重组", async () => {
    let seen: SseSniffer | null = null;
    await drain(
      teeStream(
        streamOf(['event: do', 'ne\ndata: {"finish_rea', 'son":"stop","answer":"拼好了"}\n\n']),
        new AbortController().signal,
        (s) => { seen = s; },
      ),
    );
    expect(seen!.done?.answer).toBe("拼好了");
  });

  it("末尾没有空行的帧也不会丢", async () => {
    let seen: SseSniffer | null = null;
    await drain(
      teeStream(
        streamOf(['event: done\ndata: {"answer":"最后一帧"}']),
        new AbortController().signal,
        (s) => { seen = s; },
      ),
    );
    expect(seen!.done?.answer).toBe("最后一帧");
  });

  // ★ D11
  it("客户端中途断开时仍然结算，且只结算一次", async () => {
    const ac = new AbortController();
    let calls = 0;
    let captured: SseSniffer | null = null;

    const stream = teeStream(
      streamOf(['event: done\ndata: {"answer":"已经生成完了"}\n\n']),
      ac.signal,
      (s) => { calls++; captured = s; },
    );

    const reader = stream.getReader();
    await reader.read();      // 读到 done 那一帧
    ac.abort();               // 用户关掉页面
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(1);    // flush 与 abort 都可能触发，必须幂等
    expect(captured!.done?.answer).toBe("已经生成完了");
  });
});
