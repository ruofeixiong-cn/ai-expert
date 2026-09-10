import { and, eq, sql } from "drizzle-orm";
import { tenantTx } from "../db/client.js";
import { conversations, experts, feedbacks, messages } from "../db/schema/index.js";
import { notFound } from "../core/errors.js";
import { resolveSlug } from "./chat.js";

/**
 * 疑似盲区的置信度阈值。
 *
 * **与 agent 的 `RERANK_MIN_SCORE` 同源，且应当始终相等。**
 * 见 docs/adr/001-eval-crosses-service-boundary.md。
 *
 * 相等不是巧合，是同一个判断的两个出口：
 *   入口闸门问「这些切片够不够格进 prompt」
 *   盲区检测问「这个问题库里到底有没有料」
 * 两句话说的是同一件事。所以「没过闸门」就等于「是盲区」，
 * 反过来，过了闸门的回答被点踩，那是**答得不好**，进满意度，不进盲区。
 *
 * 2026-09-10 由 M6 黄金问答集校准（`REAL_LLM=1 SWEEP=1 make eval`）：
 *   covered 题目里期望内容的最低分  0.1874
 *   uncovered 题目里候选的最高分    0.1459
 *   间隔仅 0.0415，中点 0.1667
 *
 * ⚠️ 样本 26 道、单一语料。换语料或换 embedding 模型必须重跑校准，
 *    并且【两个常量一起改】—— 只改一个会让看板和闸门各说各话。
 */
export const BLINDSPOT_CONFIDENCE = 0.15;

/**
 * 疑似盲区的判定，全系统只此一处。
 *
 * **判据只有一个：这次召回的置信度低。** 那正是「库里没有相关内容」的定义。
 *
 * 一开始写的是产品文档 §10.3 的「低置信度 **且** 被点踩」，跑真实模型时被打脸：
 *
 *   问「港股打新要准备多少现金」→ 最高 rerank 分数 0.1163 →
 *   有切片擦着入口闸门(0.05)过去了 → 模型被调用 →
 *   模型自己回答「这个他没有讲过」→ finish_reason 是 **stop 而不是 no_context**
 *
 * 结果：一个教科书级的盲区，既不满足 no_context，也没人点踩（粉丝看到
 * 「他没讲过」就走了，不会再花力气点个踩），于是看板上一条都不记。
 * 而同一批数据里，答得好的问题分数是 0.8375 —— 0.1163 和它根本不是一回事。
 *
 * 所以：
 *   - `no_context`（一条都没过闸门）只是低置信度的极端情况，被这一条包含了；
 *   - **点踩不再参与盲区判定**。点踩 + 高置信度是「有内容但答得不好」——
 *     那是风格/质量问题，该进满意度，不该进盲区。混在一起两个数都变得没法用。
 *
 * `coalesce(confidence, 0)`：NULL 意味着这次召回压根没打过分，当最低分处理。
 * **失败往「是盲区」这边倒** —— 误报博主看一眼就划走，漏报是永远发现不了的。
 *
 * ⚠️ 表别名固定为 `m`（messages）。用它的查询必须用同一个别名。
 */
const IS_BLINDSPOT = sql`coalesce(m.confidence, 0) < ${BLINDSPOT_CONFIDENCE}`;

// ─── 粉丝：点赞 / 点踩 ───────────────────────────────────────────────────────

export async function submitFeedback(
  slug: string,
  fanUserId: string,
  input: { messageId: string; rating: "up" | "down"; comment?: string },
) {
  const { expertId, tenantId } = await resolveSlug(slug);

  return tenantTx(tenantId, async (tx) => {
    /*
     * 三道校验一次做完：
     *   messages.id 存在        —— 不然打分打到空气上
     *   role = 'assistant'      —— 不能给自己的提问打分
     *   conversation 是【我的】 —— RLS 管不到这一层：张三李四可能在同一个
     *                              租户下，策略看不出区别（spec §4）
     * 任何一条不过 → 404，不是 403：不泄露这条 message_id 是否存在。
     */
    const [owned] = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.role, "assistant"),
          eq(conversations.expertId, expertId),
          eq(conversations.fanUserId, fanUserId),
        ),
      )
      .limit(1);
    if (!owned) throw notFound("这条消息不存在，或者不是你的");

    // 唯一索引 (message_id, fan_user_id) 让「改主意」变成更新而不是追加 ——
    // 否则满意度会被同一个人投两次票污染。
    // comment 显式写回：赞→踩→赞 时不该留着上一轮的原因。
    await tx
      .insert(feedbacks)
      .values({
        tenantId,
        messageId: input.messageId,
        fanUserId,
        rating: input.rating,
        comment: input.comment ?? null,
      })
      .onConflictDoUpdate({
        target: [feedbacks.messageId, feedbacks.fanUserId],
        set: { rating: input.rating, comment: input.comment ?? null, updatedAt: new Date() },
      });

    return { rating: input.rating };
  });
}

// ─── 博主：最小看板 ──────────────────────────────────────────────────────────

type StatsRow = {
  answers: number;
  up_votes: number;
  down_votes: number;
  blindspots: number;
};

type BlindspotRow = {
  message_id: string;
  question: string;
  confidence: number | null;
  reason: "no_context" | "low_confidence";
  created_at: Date;
};

/**
 * 四个数 + 最近盲区列表。
 *
 * ⚠️ 用裸 SQL 而非 Drizzle 表达式，是因为 M2 踩过：Drizzle 的关联子查询会把
 *    `${experts.id}` 渲染成裸 `"id"`，被内层表捕获，**结果恒为 0 且不报错**。
 *    裸 SQL 里写全限定名，眼睛能看见。绑定的只有值，没有列名。
 */
export async function getStats(tenantId: string, expertId: string) {
  return tenantTx(tenantId, async (tx) => {
    const [e] = await tx
      .select({ id: experts.id })
      .from(experts)
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("专家不存在");

    const counts = await tx.execute<StatsRow>(sql`
      SELECT
        count(*)::int                                      AS answers,
        count(*) FILTER (WHERE ${IS_BLINDSPOT})::int       AS blindspots,
        (SELECT count(*)::int FROM feedbacks fb
           JOIN messages mm      ON mm.id = fb.message_id
           JOIN conversations cc ON cc.id = mm.conversation_id
          WHERE cc.expert_id = ${expertId} AND fb.rating = 'up')   AS up_votes,
        (SELECT count(*)::int FROM feedbacks fb
           JOIN messages mm      ON mm.id = fb.message_id
           JOIN conversations cc ON cc.id = mm.conversation_id
          WHERE cc.expert_id = ${expertId} AND fb.rating = 'down') AS down_votes
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.expert_id = ${expertId} AND m.role = 'assistant'
    `);
    const s = counts[0] ?? { answers: 0, up_votes: 0, down_votes: 0, blindspots: 0 };

    /*
     * 问题原文用 LATERAL 取【这条回答之前最近的一条 user 消息】。
     * 按 seq 而不是 created_at —— 后者在同事务插入时会打平（0013）。
     * 博主要的是「粉丝在问什么我没讲过」，那是他下一篇文章的选题。
     */
    const list = await tx.execute<BlindspotRow>(sql`
      SELECT
        m.id AS message_id,
        coalesce(q.content, '(问题已丢失)') AS question,
        m.confidence,
        -- 'no_context' = 一条都没过闸门；'low_confidence' = 擦着过去了但很弱。
        -- 对博主是同一件事（没讲过），但排查时值得分开看。
        CASE WHEN m.finish_reason = 'no_context' THEN 'no_context' ELSE 'low_confidence' END AS reason,
        m.created_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN LATERAL (
        SELECT u.content
        FROM messages u
        WHERE u.conversation_id = m.conversation_id
          AND u.role = 'user'
          AND u.seq < m.seq
        ORDER BY u.seq DESC
        LIMIT 1
      ) q ON true
      WHERE c.expert_id = ${expertId} AND m.role = 'assistant' AND ${IS_BLINDSPOT}
      ORDER BY m.seq DESC
      LIMIT 20
    `);

    const rated = s.up_votes + s.down_votes;

    return {
      answers: s.answers,
      // 无人评价时是 null，不是 0 ——「没人评价」和「所有人都说不好」
      // 是相反的两件事，用同一个 0 表示会把博主吓死。
      satisfaction: rated === 0 ? null : Math.round((s.up_votes / rated) * 1000) / 1000,
      upVotes: s.up_votes,
      downVotes: s.down_votes,
      // M5 接入付费前，真实收入就是 0。不粉饰、不留 TODO 式的假数据，
      // 前端明写「M5 接入付费后生效」。
      revenueCents: 0,
      blindspots: s.blindspots,
      recentBlindspots: list.map((r) => ({
        messageId: r.message_id,
        question: r.question,
        confidence: r.confidence,
        reason: r.reason,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  });
}
