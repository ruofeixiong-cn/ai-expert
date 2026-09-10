import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, tenantTx } from "../src/db/client.js";
import { Code } from "../src/core/errors.js";
import { chatReservations, conversations } from "../src/db/schema/index.js";
import {
  beginChat, finishChat, getChatExpert, RESERVATION_TTL_SECONDS, type StreamOutcome,
} from "../src/services/chat.js";
import { newFan, publishedExpert } from "./helpers.js";

/**
 * B02：试聊额度可被绕过，M5 接入 credits 后就是资损。
 *
 * 第一版在开流前只「数一下已有的回答」，回答要等生成结束才落库 ——
 *   1. 同一个 Cookie 并发 10 个请求，全部通过检查；
 *   2. 在 done 之前断开，这次不计数，但模型已经调用了。
 * 技术方案 §2.2 写的本来是「开流前预扣、出错退回」，实现成了「事后数条数」。
 */
afterAll(async () => { await closeDb(); });

const meta = { confidence: 0.8, chunk_ids: [] };
const DONE: StreamOutcome = {
  meta,
  done: { answer: "完整的回答", finish_reason: "stop", safety: "pass", prompt_tokens: 10, completion_tokens: 5 },
  partial: "完整的回答",
  errored: false,
};
const NOTHING: StreamOutcome = { meta: null, done: null, partial: "", errored: false };
const PARTIAL: StreamOutcome = { meta, done: null, partial: "说到一半", errored: false };
const FAILED: StreamOutcome = { meta, done: null, partial: "说到一半", errored: true };

async function setup(freeTrial: number) {
  const { slug } = await publishedExpert(freeTrial);
  const fan = await newFan(slug);
  const remaining = async () => (await getChatExpert(slug, fan.id)).trialRemaining;
  const history = async () => (await getChatExpert(slug, fan.id)).history;
  return { slug, fan: fan.id, remaining, history };
}

describe("试聊额度", () => {
  it("并发 10 个提问、额度 3：恰好 3 个放行，其余 402", async () => {
    const { slug, fan } = await setup(3);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => beginChat(slug, fan, `问题 ${i}`)),
    );

    const denied = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(denied).toHaveLength(7);
    for (const r of denied) expect(r.reason.appCode).toBe(Code.PAYMENT_REQUIRED);
  });

  it("并发的第一次提问只建一个会话", async () => {
    const { slug, fan } = await setup(5);
    const [s] = await Promise.all([beginChat(slug, fan, "一"), beginChat(slug, fan, "二")]);

    const rows = await tenantTx(s.tenantId, (tx) =>
      tx.select().from(conversations)
        .where(and(eq(conversations.expertId, s.expertId), eq(conversations.fanUserId, fan))),
    );
    expect(rows).toHaveLength(1);
  });

  it("提问进行中，额度已经扣掉（这时刷新页面也看得到）", async () => {
    const { slug, fan, remaining } = await setup(2);
    await beginChat(slug, fan, "问题");
    expect(await remaining()).toBe(1);
  });

  it("正常结束：落一条回答，预扣转为正式扣减，不重复计", async () => {
    const { slug, fan, remaining, history } = await setup(2);
    const s = await beginChat(slug, fan, "问题");

    await finishChat(s, DONE, Date.now());

    expect(await remaining()).toBe(1);
    expect((await history()).at(-1)?.content).toBe("完整的回答");
    const left = await tenantTx(s.tenantId, (tx) =>
      tx.select().from(chatReservations).where(eq(chatReservations.id, s.assistantMessageId)),
    );
    expect(left).toHaveLength(0);
  });

  it("结算两次（flush 与 abort 都触发）：只落一条回答", async () => {
    const { slug, fan, history } = await setup(2);
    const s = await beginChat(slug, fan, "问题");

    await finishChat(s, DONE, Date.now());
    await finishChat(s, DONE, Date.now());

    expect((await history()).filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("什么都没收到就断开：退回额度", async () => {
    const { slug, fan, remaining } = await setup(1);
    const s = await beginChat(slug, fan, "问题");

    await finishChat(s, NOTHING, Date.now());

    expect(await remaining()).toBe(1);
  });

  it("生成出错（哪怕已经吐了半句）：退回额度 —— 那是我们的错", async () => {
    const { slug, fan, remaining } = await setup(1);
    const s = await beginChat(slug, fan, "问题");

    await finishChat(s, FAILED, Date.now());

    expect(await remaining()).toBe(1);
  });

  it("看到部分回答后断开：计入额度，并把粉丝看到的那部分落库", async () => {
    const { slug, fan, remaining, history } = await setup(1);
    const s = await beginChat(slug, fan, "问题");

    await finishChat(s, PARTIAL, Date.now());

    expect(await remaining()).toBe(0);
    expect((await history()).at(-1)?.content).toBe("说到一半");
  });

  it("进程在结算前崩溃：过期的预扣不再占着额度", async () => {
    const { slug, fan, remaining } = await setup(1);
    const s = await beginChat(slug, fan, "问题");
    expect(await remaining()).toBe(0);

    // 模拟崩溃：预扣留在库里没人结算，把它拨到有效期之前
    await tenantTx(s.tenantId, (tx) =>
      tx.update(chatReservations)
        .set({ createdAt: new Date(Date.now() - (RESERVATION_TTL_SECONDS + 60) * 1000) })
        .where(eq(chatReservations.id, s.assistantMessageId)),
    );

    expect(await remaining()).toBe(1);
  });
});
