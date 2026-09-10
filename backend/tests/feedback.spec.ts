import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { closeDb, tenantTx } from "../src/db/client.js";
import {
  conversations, experts, expertModelDrafts, feedbacks, messages,
} from "../src/db/schema/index.js";

const app = createApp();
const uniq = () => `f${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

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

type Expert = { token: string; tenantId: string; id: string; slug: string };

async function publishedExpert(): Promise<Expert> {
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
  const pub = (await json(await call(`/api/experts/${id}/publish`, { method: "POST", token }))).data;
  return { token, tenantId, id, slug: pub.shareSlug as string };
}

/** 拿一个匿名粉丝身份（Cookie + userId）。 */
async function newFan(slug: string) {
  const res = await call(`/api/chat/${slug}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const { readFanToken } = await import("../src/services/chat.js");
  const id = await readFanToken(cookie.replace("ae_fan=", ""));
  if (!id) throw new Error("Cookie 里没有有效的粉丝身份");
  return { cookie, id };
}

/**
 * 直接往库里塞一轮问答。
 *
 * 不走真实对话是刻意的：M4 要验的是【反馈与盲区判定】，
 * 把 confidence / finish_reason 精确控制住，才能分清 F6 和 F7 的差别 ——
 * 走真实模型的话这两个值是浮动的，测试会时准时不准。
 */
async function seedTurn(
  e: Expert,
  fanUserId: string,
  q: string,
  a: { confidence: number | null; finishReason?: string },
) {
  return tenantTx(e.tenantId, async (tx) => {
    let [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.expertId, e.id), eq(conversations.fanUserId, fanUserId)))
      .limit(1);
    if (!conv) {
      [conv] = await tx.insert(conversations)
        .values({ tenantId: e.tenantId, expertId: e.id, fanUserId })
        .returning({ id: conversations.id });
    }
    await tx.insert(messages).values({
      tenantId: e.tenantId, conversationId: conv!.id, role: "user", content: q,
    });
    const [ans] = await tx.insert(messages).values({
      tenantId: e.tenantId, conversationId: conv!.id, role: "assistant",
      content: `关于「${q}」……`,
      confidence: a.confidence,
      finishReason: a.finishReason ?? "stop",
    }).returning({ id: messages.id });
    return ans!.id;
  });
}

const stats = async (e: Expert) =>
  (await json(await call(`/api/experts/${e.id}/stats`, { token: e.token }))).data;

const rate = (slug: string, cookie: string, body: unknown) =>
  call(`/api/chat/${slug}/feedback`, { method: "POST", cookie, body: JSON.stringify(body) });

beforeAll(async () => {
  const body = await json(await app.request("/readyz"));
  if (body.data.database !== "ok") throw new Error("数据库不可达 —— 先 `make up && make migrate`");
});
afterAll(async () => { await closeDb(); });

// ─── 打分 ────────────────────────────────────────────────────────────────────

describe("点赞点踩", () => {
  it("能给一条回答点赞，落库", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    const msgId = await seedTurn(e, fan.id, "定投手续费能省吗", { confidence: 0.3 });

    const res = await rate(e.slug, fan.cookie, { messageId: msgId, rating: "up" });
    expect(res.status).toBe(200);
    expect((await json(res)).data.rating).toBe("up");

    const rows = await tenantTx(e.tenantId, (tx) =>
      tx.select().from(feedbacks).where(eq(feedbacks.messageId, msgId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe("up");
  });

  // ★ F2
  it("改主意：先赞后踩，库里只有一条且是踩", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    const msgId = await seedTurn(e, fan.id, "要不要止盈", { confidence: 0.3 });

    await rate(e.slug, fan.cookie, { messageId: msgId, rating: "up", comment: "说得好" });
    await rate(e.slug, fan.cookie, { messageId: msgId, rating: "down" });

    const rows = await tenantTx(e.tenantId, (tx) =>
      tx.select().from(feedbacks).where(eq(feedbacks.messageId, msgId)),
    );
    // 追加而不是更新的话，满意度会被同一个人投两次票污染
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe("down");
    // 改主意时旧的原因要清掉，不能留着上一轮的
    expect(rows[0]!.comment).toBeNull();
  });

  // ★ F3
  it("点踩可以附原因，超过 200 字被拒", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    const msgId = await seedTurn(e, fan.id, "怎么选基金", { confidence: 0.3 });

    await rate(e.slug, fan.cookie, { messageId: msgId, rating: "down", comment: "答非所问" });
    const [row] = await tenantTx(e.tenantId, (tx) =>
      tx.select().from(feedbacks).where(eq(feedbacks.messageId, msgId)),
    );
    expect(row!.comment).toBe("答非所问");

    const tooLong = await rate(e.slug, fan.cookie, {
      messageId: msgId, rating: "down", comment: "字".repeat(201),
    });
    expect(tooLong.status).toBe(400);
    expect((await json(tooLong)).code).toBe(1001);
  });

  it("不能给自己的【提问】打分", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    await seedTurn(e, fan.id, "一个问题", { confidence: 0.3 });
    const [userMsg] = await tenantTx(e.tenantId, (tx) =>
      tx.select({ id: messages.id }).from(messages).where(eq(messages.role, "user")).limit(1),
    );
    const res = await rate(e.slug, fan.cookie, { messageId: userMsg!.id, rating: "up" });
    expect(res.status).toBe(404);
  });
});

// ─── 隔离 ────────────────────────────────────────────────────────────────────

describe("打分的归属校验", () => {
  // ★ F4 —— RLS 管不到这一层，靠应用层显式 join
  it("打不了别人的分：拿到他人会话的 message_id 也是 404，且库里无新增", async () => {
    const e = await publishedExpert();
    const victim = await newFan(e.slug);
    const attacker = await newFan(e.slug);
    const msgId = await seedTurn(e, victim.id, "受害者的问题", { confidence: 0.3 });

    const res = await rate(e.slug, attacker.cookie, { messageId: msgId, rating: "down" });
    // 404 而不是 403 —— 不泄露这条 message_id 是否存在
    expect(res.status).toBe(404);

    const rows = await tenantTx(e.tenantId, (tx) =>
      tx.select().from(feedbacks).where(eq(feedbacks.messageId, msgId)),
    );
    expect(rows).toHaveLength(0);
  });

  // ★ F5
  it("跨租户：A 租户的 message_id 用 B 的短链提交，404", async () => {
    const a = await publishedExpert();
    const b = await publishedExpert();
    const fanA = await newFan(a.slug);
    const msgInA = await seedTurn(a, fanA.id, "A 租户的问题", { confidence: 0.3 });

    const fanB = await newFan(b.slug);
    const res = await rate(b.slug, fanB.cookie, { messageId: msgInA, rating: "down" });
    expect(res.status).toBe(404);

    const rows = await tenantTx(a.tenantId, (tx) =>
      tx.select().from(feedbacks).where(eq(feedbacks.messageId, msgInA)),
    );
    expect(rows).toHaveLength(0);
  });
});

// ─── 看板 ────────────────────────────────────────────────────────────────────

describe("Creator 最小看板", () => {
  // ★ F10
  it("一条反馈都没有时，满意度是 null 而不是 0", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    await seedTurn(e, fan.id, "问题", { confidence: 0.3 });

    const s = await stats(e);
    expect(s.answers).toBe(1);
    // 「没人评价」和「所有人都说不好」是相反的两件事
    expect(s.satisfaction).toBeNull();
    expect(s.blindspots).toBe(0);
  });

  /*
   * ★ F6 —— 低置信度就是盲区，【不需要】任何人点踩。
   *
   * 第一版按产品文档写成「低置信度 且 被点踩」，被真实模型打脸：
   * 一个 0.1163 的问题擦着入口闸门过去了，模型自己答「这个他没有讲过」，
   * finish_reason 是 stop 不是 no_context，粉丝看完就走也没点踩 ——
   * 教科书级的盲区，一条都没记上。详见 services/feedback.ts 的注释。
   */
  it("低置信度就是盲区，不需要任何人点踩", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    // 0.1163 是真实测出来的那个值
    await seedTurn(e, fan.id, "港股打新要准备多少现金", { confidence: 0.1163 });

    const s = await stats(e);
    expect(s.downVotes).toBe(0);
    expect(s.blindspots).toBe(1);
    expect(s.recentBlindspots[0].reason).toBe("low_confidence");
  });

  // ★ F7 —— F6 的对照组。缺了它，「盲区」就退化成「所有回答」
  it("高置信度 + 点踩 ≠ 盲区（那是答得不好，不是没讲过）", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    // 0.8375 也是真实测出来的：库里确实讲过这件事
    const msgId = await seedTurn(e, fan.id, "定投的手续费怎么算", { confidence: 0.8375 });

    await rate(e.slug, fan.cookie, { messageId: msgId, rating: "down" });
    const s = await stats(e);
    // 差评要进满意度
    expect(s.downVotes).toBe(1);
    expect(s.satisfaction).toBe(0);
    // 但不该进盲区 —— 混在一起两个数都会变得没法用
    expect(s.blindspots).toBe(0);
  });

  // ★ F8 —— 隐性信号，不需要粉丝点任何按钮
  it("no_context 的回答无需任何点击就计入盲区", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    await seedTurn(e, fan.id, "比特币明年涨到多少", { confidence: null, finishReason: "no_context" });

    const s = await stats(e);
    expect(s.blindspots).toBe(1);
    expect(s.downVotes).toBe(0); // 一次都没点
  });

  // ★ F9
  it("四个数：回答数 / 满意度 / 收入 / 盲区数", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    const m1 = await seedTurn(e, fan.id, "问题一", { confidence: 0.4 });
    const m2 = await seedTurn(e, fan.id, "问题二", { confidence: 0.4 });
    const m3 = await seedTurn(e, fan.id, "问题三", { confidence: 0.02 });

    await rate(e.slug, fan.cookie, { messageId: m1, rating: "up" });
    await rate(e.slug, fan.cookie, { messageId: m2, rating: "up" });
    await rate(e.slug, fan.cookie, { messageId: m3, rating: "down" });

    const s = await stats(e);
    expect(s.answers).toBe(3);
    expect(s.upVotes).toBe(2);
    expect(s.downVotes).toBe(1);
    expect(s.satisfaction).toBeCloseTo(2 / 3, 3);
    expect(s.blindspots).toBe(1);
    // M5 之前真实收入就是 0 —— 不粉饰
    expect(s.revenueCents).toBe(0);
  });

  // ★ F11 —— 一个数字不可行动，问题原文才是选题
  it("盲区列表给的是问题原文，不是回答", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    await seedTurn(e, fan.id, "港股打新怎么操作", { confidence: null, finishReason: "no_context" });
    await seedTurn(e, fan.id, "可转债怎么玩", { confidence: 0.07 });

    const s = await stats(e);
    expect(s.recentBlindspots).toHaveLength(2);
    const byQ = Object.fromEntries(s.recentBlindspots.map((b: any) => [b.question, b.reason]));
    // 对博主是同一件事（没讲过），排查时值得分开看
    expect(byQ["港股打新怎么操作"]).toBe("no_context");
    expect(byQ["可转债怎么玩"]).toBe("low_confidence");
  });

  // ★ F12
  it("未登录看不到看板，别人的专家也看不到", async () => {
    const e = await publishedExpert();
    expect((await call(`/api/experts/${e.id}/stats`)).status).toBe(401);

    const other = await publishedExpert();
    // 不属于当前租户返回 404 而非 403 —— 不泄露资源是否存在
    const res = await call(`/api/experts/${e.id}/stats`, { token: other.token });
    expect(res.status).toBe(404);
  });
});

// ─── 历史回显（补 M3 的漏洞）────────────────────────────────────────────────

describe("分享页历史", () => {
  // ★ F1
  it("重新打开分享页能看到历史消息，且已打的分还在", async () => {
    const e = await publishedExpert();
    const fan = await newFan(e.slug);
    const msgId = await seedTurn(e, fan.id, "定投要多久", { confidence: 0.3 });
    await rate(e.slug, fan.cookie, { messageId: msgId, rating: "up" });

    const d = (await json(await call(`/api/chat/${e.slug}`, { cookie: fan.cookie }))).data;
    expect(d.history).toHaveLength(2);
    expect(d.history[0].role).toBe("user");
    expect(d.history[0].content).toBe("定投要多久");
    expect(d.history[1].role).toBe("assistant");
    // 不回显的话粉丝会以为没点成功、再点一遍
    expect(d.history[1].myRating).toBe("up");
  });

  it("换一个粉丝看不到别人的历史", async () => {
    const e = await publishedExpert();
    const a = await newFan(e.slug);
    await seedTurn(e, a.id, "A 的问题", { confidence: 0.3 });

    const b = await newFan(e.slug);
    const d = (await json(await call(`/api/chat/${e.slug}`, { cookie: b.cookie }))).data;
    expect(d.history).toHaveLength(0);
  });
});
