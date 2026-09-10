import { and, eq, lt, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { getDb, systemTx, tenantTx, type Tx } from "../db/client.js";
import { chatReservations, conversations, experts, messages, users } from "../db/schema/index.js";
import { AppError, Code, notFound } from "../core/errors.js";
import { env } from "../env.js";
import type { DoneData, MetaData } from "./sse.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * 预扣的有效期（B02）。
 *
 * 比一次生成的最长耗时宽裕得多。过期的预扣不再计入额度 ——
 * 进程在结算前崩溃（部署、OOM）时，粉丝的额度不会被永久占住。
 */
export const RESERVATION_TTL_SECONDS = 300;

/**
 * 按分享短链解析出 (expertId, tenantId)。
 *
 * 这是 RLS 上唯一一个受控的口子 —— 粉丝不属于任何租户，拿到 slug 时
 * 后端不知道该设哪个 app.current_tenant。函数是 SECURITY DEFINER，
 * 只返回两个 uuid、只对已上线的专家返回，且只有 app_backend 能调用。
 * 详见 drizzle/0010_share_lookup.sql 的注释。
 *
 * 拿到 tenantId 之后，后续所有查询照常走 tenantTx，RLS 全程生效。
 */
export async function resolveSlug(slug: string) {
  const rows = await getDb().execute<{ expert_id: string; tenant_id: string }>(
    sql`select * from resolve_share_slug(${slug})`,
  );
  const row = rows[0];
  // 短链无效与专家未上线返回同一个 404 —— 不泄露这个短链是否存在过
  if (!row) throw notFound("这个链接无效，或者专家还没有上线");
  return { expertId: row.expert_id, tenantId: row.tenant_id };
}

// ─── 匿名粉丝身份 ────────────────────────────────────────────────────────────
//
// 分享页首屏要求注册 = 转化率归零。所以首次访问就建一个匿名账号，
// 用签名 Cookie 记住它，试聊额度按它计。
// M5 接支付时登录即合并到真实账号（users.is_anonymous 已预留）。

export async function signFanToken(userId: string) {
  return new SignJWT({ anon: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("180d")
    .sign(secret);
}

export async function readFanToken(token: string | null): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return payload.anon === true && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function createAnonymousFan() {
  const [row] = await systemTx((tx) =>
    tx.insert(users).values({ role: "user", isAnonymous: true }).returning({ id: users.id }),
  );
  if (!row) throw new AppError(Code.INTERNAL, "创建访客身份失败", 500);
  return row.id;
}

/** Cookie 里的粉丝还在不在（库被清过、或伪造）—— 不在就当新访客。 */
export async function fanExists(userId: string) {
  const [row] = await systemTx((tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
  );
  return Boolean(row);
}

// ─── 专家信息与试聊额度 ──────────────────────────────────────────────────────

type HistoryRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  my_rating: "up" | "down" | null;
};

export async function getChatExpert(slug: string, fanUserId: string | null) {
  const { expertId, tenantId } = await resolveSlug(slug);

  return tenantTx(tenantId, async (tx) => {
    const [e] = await tx
      .select({
        name: experts.name,
        creatorNickname: users.nickname,
        priceCents: experts.priceCents,
        freeTrial: experts.freeTrialMessages,
        knowledgeSize: sql<number>`(select count(*)::int from chunks c where c.expert_id = experts.id)`,
      })
      .from(experts)
      // users 没有 RLS，直接在这个事务里 join。第一版在这里又开了一个 systemTx
      // 去查昵称 —— 一个请求同时占两个连接，并发一高就把连接池耗死（B04）
      .leftJoin(users, eq(users.id, experts.ownerId))
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("这个链接无效，或者专家还没有上线");

    const used = fanUserId ? await countUsed(tx, expertId, fanUserId) : 0;

    /*
     * 历史消息。M3 漏了这个：粉丝关掉页面再打开，屏幕空空如也，
     * 却显示「剩余 1 条」—— 额度是按库里的回答数算的，屏幕不是。
     *
     * my_rating 一起带出来，否则刷新之后赞/踩按钮全部回到未选中状态，
     * 粉丝会以为没点成功、再点一遍。
     */
    const history = fanUserId
      ? (
          await tx.execute<HistoryRow>(sql`
            SELECT m.id, m.role, m.content,
                   (SELECT fb.rating FROM feedbacks fb
                     WHERE fb.message_id = m.id AND fb.fan_user_id = ${fanUserId}) AS my_rating
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.expert_id = ${expertId} AND c.fan_user_id = ${fanUserId}
            ORDER BY m.seq DESC
            LIMIT 50
          `)
        )
          .map((r) => ({
            id: r.id,
            role: r.role,
            content: r.content,
            myRating: r.my_rating,
          }))
          .reverse()
      : [];

    return {
      name: e.name,
      creatorNickname: e.creatorNickname ?? null,
      knowledgeSize: e.knowledgeSize,
      priceCents: e.priceCents,
      trialRemaining: Math.max(0, e.freeTrial - used),
      history,
    };
  });
}

/**
 * 已用条数 = 已落库的助手回答 + 还在有效期内的预扣（B02）。
 *
 * 第一版只数回答，而回答要等生成结束才落库 ——「检查额度」和「扣额度」之间
 * 隔着一整次生成（几秒），同一个粉丝并发 10 个请求全部能通过检查。
 * 所以开流前先预扣一条，结算时转为正式回答，出错时退回。
 *
 * 「发了问题但没收到回答不扣」这条规则不变：那种情况下预扣会被退回。
 */
async function countUsed(tx: Tx, expertId: string, fanUserId: string) {
  const [row] = await tx.execute<{ n: number }>(sql`
    SELECT
      (SELECT count(*) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.expert_id = ${expertId} AND c.fan_user_id = ${fanUserId} AND m.role = 'assistant')
    + (SELECT count(*) FROM chat_reservations r
        WHERE r.expert_id = ${expertId} AND r.fan_user_id = ${fanUserId}
          AND r.created_at > now() - make_interval(secs => ${RESERVATION_TTL_SECONDS}))
    AS n
  `);
  return Number(row?.n ?? 0);
}

export type ChatSession = {
  expertId: string;
  tenantId: string;
  conversationId: string;
  userMessageId: string;
  /**
   * 这条回答将来的主键，提问时就先定好。同时也是这次预扣的 id。
   *
   * 传给 agent，由它原样回显在 meta 事件里，前端拿去打分。
   * 【不能让 agent 自己生成】：那个 id 不指向 messages 表里的任何一行，
   * 反馈接口稳定 404。落库是 backend 的事，主键当然也归它。
   */
  assistantMessageId: string;
};

/**
 * 开始一次提问：校验额度、预扣一条、建会话、落用户消息。
 * 额度不足时抛 402 —— 由调用方转成 `event: error`，而不是断流。
 */
export async function beginChat(
  slug: string,
  fanUserId: string,
  question: string,
): Promise<ChatSession> {
  const { expertId, tenantId } = await resolveSlug(slug);

  return tenantTx(tenantId, async (tx) => {
    // 同一个粉丝对同一个专家的提问，在这里串行化（B02）。
    // 没有这把锁，「数已用条数」和「写预扣」之间可以插进另一个请求 ——
    // 并发 10 个请求会全部通过额度检查，第一次提问时还会并发建出两个会话。
    // 事务级锁：提交或回滚时自动释放，不存在忘记解锁。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat:${expertId}:${fanUserId}`}, 0))`,
    );

    const [e] = await tx
      .select({ freeTrial: experts.freeTrialMessages })
      .from(experts)
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("这个链接无效，或者专家还没有上线");

    // 顺手清掉这个粉丝过期的预扣（进程崩溃留下的），省得再开一个定时任务
    await tx
      .delete(chatReservations)
      .where(
        and(
          eq(chatReservations.expertId, expertId),
          eq(chatReservations.fanUserId, fanUserId),
          lt(chatReservations.createdAt, sql`now() - make_interval(secs => ${RESERVATION_TTL_SECONDS})`),
        ),
      );

    if ((await countUsed(tx, expertId, fanUserId)) >= e.freeTrial) {
      throw new AppError(
        Code.PAYMENT_REQUIRED,
        "试聊次数已用完。付费功能马上就来，先收藏一下吧。",
        402,
      );
    }

    let [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.expertId, expertId), eq(conversations.fanUserId, fanUserId)))
      .limit(1);

    if (!conv) {
      [conv] = await tx
        .insert(conversations)
        .values({ tenantId, expertId, fanUserId })
        .returning({ id: conversations.id });
    }
    if (!conv) throw new AppError(Code.INTERNAL, "创建会话失败", 500);

    const [msg] = await tx
      .insert(messages)
      .values({ tenantId, conversationId: conv.id, role: "user", content: question })
      .returning({ id: messages.id });
    if (!msg) throw new AppError(Code.INTERNAL, "记录提问失败", 500);

    const assistantMessageId = crypto.randomUUID();
    await tx.insert(chatReservations).values({ id: assistantMessageId, tenantId, expertId, fanUserId });

    return {
      expertId,
      tenantId,
      conversationId: conv.id,
      userMessageId: msg.id,
      assistantMessageId,
    };
  });
}

export type Settlement = {
  answer: string;
  chunkIds: string[];
  confidence: number | null;
  finishReason: string;
  /** null = 没过出口闸门（中途断开时，全文还没生成完） */
  safety: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

/**
 * 落回答，并把预扣转为正式扣减 —— 两件事在同一个事务里，
 * 同一条回答在任何时刻都只被算一次。
 *
 * ⚠️ 必须幂等：正常结束走 TransformStream 的 flush，客户端中途断开走 abort，
 *    两条路径都可能触发它。调用方用 settled 标志挡一层；这里再按主键挡一层 ——
 *    这条回答的 id 在提问时就定好了，查它在不在就知道结算过没有。
 */
export async function settleChat(s: ChatSession, r: Settlement) {
  await tenantTx(s.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, s.assistantMessageId))
      .limit(1);

    if (!existing) {
      await tx.insert(messages).values({
        // 必须用提问时就定好的那个 id —— meta 事件已经把它发给前端了
        id: s.assistantMessageId,
        tenantId: s.tenantId,
        conversationId: s.conversationId,
        role: "assistant",
        content: r.answer,
        chunkIds: r.chunkIds,
        confidence: r.confidence,
        finishReason: r.finishReason,
        safety: r.safety,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        latencyMs: r.latencyMs,
      });
    }
    await tx.delete(chatReservations).where(eq(chatReservations.id, s.assistantMessageId));
  });
}

/** 退回预扣：这次提问没有产生粉丝看得到、且该由他买单的回答（B02）。 */
export async function releaseChat(s: ChatSession) {
  await tenantTx(s.tenantId, (tx) =>
    tx.delete(chatReservations).where(eq(chatReservations.id, s.assistantMessageId)),
  );
}

/** 一次流式回答结束时嗅探到的东西。SseSniffer 的实例天然满足这个形状。 */
export type StreamOutcome = {
  meta: MetaData | null;
  done: DoneData | null;
  /** 已经转发给粉丝的增量文本 */
  partial: string;
  errored: boolean;
};

/**
 * 一次提问结束时怎么算账（B02）。
 *
 *   出错（event: error）          → 退回。哪怕已经吐了半句 —— 那是我们的错，不该算粉丝的
 *   收到 done                     → 落回答，预扣转为正式扣减
 *   没有 done，但粉丝已看到部分回答 → 中途断开。按已消费计，把他看到的那部分落库；
 *                                   否则「看到九成再关页面」就能无限白嫖
 *   什么都没收到                   → 退回
 */
export async function finishChat(s: ChatSession, r: StreamOutcome, startedAt: number) {
  if (r.errored) return releaseChat(s);

  const answer = r.done?.answer ?? r.partial;
  if (!r.done && !answer) return releaseChat(s);

  await settleChat(s, {
    answer,
    chunkIds: r.meta?.chunk_ids ?? [],
    confidence: r.meta?.confidence ?? null,
    finishReason: r.done?.finish_reason ?? "aborted",
    safety: r.done?.safety ?? null,
    promptTokens: r.done?.prompt_tokens ?? 0,
    completionTokens: r.done?.completion_tokens ?? 0,
    latencyMs: r.done?.latency_ms ?? Date.now() - startedAt,
  });
}
