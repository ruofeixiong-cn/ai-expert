import { and, count, eq, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { getDb, systemTx, tenantTx } from "../db/client.js";
import { conversations, experts, messages, users } from "../db/schema/index.js";
import { AppError, Code, notFound } from "../core/errors.js";
import { env } from "../env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

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
        ownerId: experts.ownerId,
        priceCents: experts.priceCents,
        freeTrial: experts.freeTrialMessages,
        knowledgeSize: sql<number>`(select count(*)::int from chunks c where c.expert_id = experts.id)`,
      })
      .from(experts)
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("这个链接无效，或者专家还没有上线");

    const [owner] = await systemTx((t2) =>
      t2.select({ nickname: users.nickname }).from(users).where(eq(users.id, e.ownerId)).limit(1),
    );

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
      creatorNickname: owner?.nickname ?? null,
      knowledgeSize: e.knowledgeSize,
      priceCents: e.priceCents,
      trialRemaining: Math.max(0, e.freeTrial - used),
      history,
    };
  });
}

/** 已用条数按【助手回答】计 —— 用户发了问题但没收到回答不该扣额度。 */
async function countUsed(
  tx: Parameters<Parameters<typeof tenantTx>[1]>[0],
  expertId: string,
  fanUserId: string,
) {
  const [row] = await tx
    .select({ n: count() })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.expertId, expertId),
        eq(conversations.fanUserId, fanUserId),
        eq(messages.role, "assistant"),
      ),
    );
  return row?.n ?? 0;
}

export type ChatSession = {
  expertId: string;
  tenantId: string;
  conversationId: string;
  userMessageId: string;
  /**
   * 这条回答将来的主键，提问时就先定好。
   *
   * 传给 agent，由它原样回显在 meta 事件里，前端拿去打分。
   * 【不能让 agent 自己生成】：那个 id 不指向 messages 表里的任何一行，
   * 反馈接口稳定 404。落库是 backend 的事，主键当然也归它。
   */
  assistantMessageId: string;
};

/**
 * 开始一次提问：校验额度、建会话、落用户消息。
 * 额度不足时抛 402 —— 由调用方转成 `event: error`，而不是断流。
 */
export async function beginChat(
  slug: string,
  fanUserId: string,
  question: string,
): Promise<ChatSession> {
  const { expertId, tenantId } = await resolveSlug(slug);

  return tenantTx(tenantId, async (tx) => {
    const [e] = await tx
      .select({ freeTrial: experts.freeTrialMessages })
      .from(experts)
      .where(eq(experts.id, expertId))
      .limit(1);
    if (!e) throw notFound("这个链接无效，或者专家还没有上线");

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

    return {
      expertId,
      tenantId,
      conversationId: conv.id,
      userMessageId: msg.id,
      assistantMessageId: crypto.randomUUID(),
    };
  });
}

export type Settlement = {
  answer: string;
  chunkIds: string[];
  confidence: number | null;
  finishReason: string;
  safety: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

/**
 * 落回答。
 *
 * ⚠️ 必须幂等：正常结束走 TransformStream 的 flush，客户端中途断开走 abort，
 *    两条路径都可能触发它，而且可能都触发。用 conversation + 时间窗去重
 *    太脆，直接在调用方用一个 settled 标志挡住 —— 这里再做一层数据库侧的
 *    防御：同一条 user message 只允许有一条 assistant 回答。
 */
export async function settleChat(s: ChatSession, r: Settlement) {
  await tenantTx(s.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, s.conversationId),
          eq(messages.role, "assistant"),
          // 用 seq 不用 created_at：同事务插入的两条消息时间戳相同，
          // `>` 会漏判。见 drizzle/0013_message_seq.sql。
          sql`${messages.seq} > (select seq from messages where id = ${s.userMessageId})`,
        ),
      )
      .limit(1);
    if (existing) return; // 已经结算过

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
  });
}
