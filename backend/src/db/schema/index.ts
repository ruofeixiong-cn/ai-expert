import {
  pgTable, uuid, text, timestamp, integer, boolean,
  jsonb, doublePrecision, vector, index, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * M0 首版表结构。
 *
 * 归属规则（见 specs/001-m0-foundation/plan.md）：
 *   这个文件是【全系统唯一的 DDL 来源】。Python agent 侧的 app/db/tables.py
 *   是它的手写镜像，由 agent/tests/test_schema_drift.py 保证不漂移。
 *
 * RLS 归属：experts / chunks / build_jobs 三张表按 tenant_id 隔离，
 *   策略写在 drizzle/0001_rls_and_roles.sql（drizzle-kit 不生成 RLS）。
 */

// ── users ────────────────────────────────────────────────────
// 不做 RLS：注册/登录发生在租户上下文之外。
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone"),
    email: text("email"),
    passwordHash: text("password_hash"),
    // 'creator' | 'user'
    role: text("role").notNull().default("user"),
    // 免登录试聊的匿名访客也落一行；登录时做账户合并。
    // 这是 credit_ledger 按 user_id 记账的前提（M5 要用）。
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    nickname: text("nickname"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_key").on(t.phone),
    uniqueIndex("users_email_key").on(t.email),
  ],
);

// ── tenants ──────────────────────────────────────────────────
// 租户 = 博主。不做 RLS：租户表本身就是隔离的锚点。
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── auth_sessions ────────────────────────────────────────────
// 一次登录 = 一个会话族。refresh token 轮换时族不变，族被吊销则该设备全部失效。
// 不做 RLS：认证发生在租户上下文之外（和 users / tenants 一样）。
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // 冗余存一份：中间件校验会话时一次读取就能拿到租户，省一次 join
    tenantId: uuid("tenant_id").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    // 会话的绝对上限。刷新只能延长 refresh token，不能突破这个时间 ——
    // 否则一次登录可以靠不断刷新永久有效，等于没有过期。
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // 'logout' | 'logout_all' | 'reuse_detected' | 'expired'
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

// ── refresh_tokens ───────────────────────────────────────────
// 每次轮换插一行新的、把旧的标记 used_at。保留历史是【重放检测的前提】：
// 已经用过的 token 再次出现，说明它被人复制走了 —— 此时吊销整个会话族。
// 如果用 Redis + TTL，过期记录会消失，重放就退化成"未知 token"，
// 只能拒绝这一次，无法发现"已经泄露了"。所以放 Postgres。
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => authSessions.id, { onDelete: "cascade" }),
    // 只存 sha256。库泄露了也拿不到可用的 token。
    // 用 sha256 而不是 argon2 是对的：慢哈希是为了对抗【低熵】口令的爆破，
    // 而这里是 256 位随机串，没有可爆破性，慢哈希只会白白拖慢每次刷新。
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // 非空 = 已被用于刷新过。再次出现即为重放。
    usedAt: timestamp("used_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_hash_key").on(t.tokenHash),
    index("refresh_tokens_session_idx").on(t.sessionId),
  ],
);

// ── login_attempts ───────────────────────────────────────────
// 登录爆破节流。只在【失败】时写入，量很小。
// M3 做全局限流时会整体挪到 Redis 令牌桶；现在为一个功能引 Redis 客户端不值。
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'ip:1.2.3.4' 或 'account:a@b.com'，两个维度都限
    key: text("key").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_key_time_idx").on(t.key, t.attemptedAt)],
);

// ── experts ──────────────────────────────────────────────────
export const experts = pgTable(
  "experts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    // ── 专家模型的三个状态，刻意分开存 ──────────────────────
    //
    //   expert_model_drafts.model  「AI 说的」    agent 写
    //   experts.confirmed_model    「博主认过的」 逐维度确认，博主写
    //   experts.expert_model       「粉丝在用的」 上线时的快照
    //
    // 为什么不合并成一个字段：
    //   合并的话，博主重新生成七维会【悄悄改变付费粉丝拿到的东西】。
    //   上线即快照，之后怎么改草稿都不影响线上，直到他再次点上线。
    //
    // confirmed_model 是【部分】的：只含博主确认过的维度。
    // 未确认的维度按草稿「默认通过」（产品文档 §8.4）。
    confirmedModel: jsonb("confirmed_model"),
    // 上线快照。未上线时为 null。M3 的对话只读这一个字段。
    expertModel: jsonb("expert_model"),
    // 'building' | 'online' | 'offline'
    status: text("status").notNull().default("building"),
    priceCents: integer("price_cents").notNull().default(0),
    shareSlug: text("share_slug"),
    // 博主已确认的维度。未确认的按草稿「默认通过」（产品文档 §8.4）。
    confirmedDimensions: text("confirmed_dimensions").array().notNull().default([]),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("experts_share_slug_key").on(t.shareSlug),
    index("experts_tenant_idx").on(t.tenantId),
  ],
);

// ── expert_model_drafts ──────────────────────────────────────
// AI 生成的七维草稿。agent 写，backend 读。
//
// 为什么单独一张表，而不是往 experts.expert_model 里写：
//   1) app_agent 只被 GRANT 了它需要的表。给它 experts 的 UPDATE 权限，
//      等于打开"内容处理服务能改业务表"的口子
//   2) 另一个做法是 agent 回调 backend，但那会让 agent → backend 也产生依赖，
//      两个服务互相调，边界就糊了
//   3) 产品语义本来就是两个状态：「AI 说的」和「博主认过的」。
//      落成两张表比一个字段加 confirmed 布尔更清楚，
//      也天然支持"重新生成不覆盖已确认内容"
export const expertModelDrafts = pgTable(
  "expert_model_drafts",
  {
    // 一个专家一份草稿，整行替换
    expertId: uuid("expert_id").primaryKey().references(() => experts.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    // 七维结构见 backend/src/schemas/model.ts 的 ExpertModel
    model: jsonb("model").notNull(),
    // 这份草稿基于多少个切片生成 —— 让博主知道 AI 读了多少内容
    chunkCount: integer("chunk_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("expert_model_drafts_tenant_idx").on(t.tenantId)],
);

// ── materials ────────────────────────────────────────────────
// 博主上传的原始素材。Node 写，Python 只读（GRANT SELECT）。
//
// M1 不接 OSS：原文直接存 raw_text。storage_key 现在建好但留空，
// 接 OSS 时只需填这个字段 + 把 raw_text 改成惰性加载，不用改表。
//
// 刻意【没有 status 列】：构建状态统一看 build_jobs，
// 两处状态互相矛盾比没有状态更难排查。
export const materials = pgTable(
  "materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    expertId: uuid("expert_id").notNull().references(() => experts.id, { onDelete: "cascade" }),
    // 'paste'（粘贴正文，最可靠）| 'file'（上传文件）| 'url'（链接，只承诺公众号）
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    title: text("title"),
    rawText: text("raw_text").notNull(),
    // sha256(raw_text)，同一专家下唯一 —— 博主重复粘贴不会重复烧向量化的钱
    contentHash: text("content_hash").notNull(),
    // OSS 对象键，M1 恒为空
    storageKey: text("storage_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("materials_tenant_expert_idx").on(t.tenantId, t.expertId),
    // 去重在数据库层强制，不靠应用层记得查
    uniqueIndex("materials_expert_hash_key").on(t.expertId, t.contentHash),
  ],
);

// ── chunks ───────────────────────────────────────────────────
// Python agent 唯一读写的核心表。
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    expertId: uuid("expert_id").notNull().references(() => experts.id),
    // 溯源：这条切片出自哪篇素材。M3 回答时要能说"出自哪篇文章"。
    // 可空 —— 平台公共知识层（见 MVP 文档 §9.2）没有对应素材。
    materialId: uuid("material_id").references(() => materials.id, { onDelete: "cascade" }),
    // 四路召回：'knowledge' | 'belief' | 'methodology' | 'decision' | 'example'
    channel: text("channel").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    // 'creator' | 'user_input' | 'external' | 'platform'
    // 拼 prompt 时显式标注来源，是防注入 4 条里的第 3 条
    source: text("source").notNull().default("creator"),
    confidence: doublePrecision("confidence"),
    // 命中注入特征（"忽略以上指令"等）。标记而非删除 ——
    // 博主可能就是在写"如何防范提示词注入"的正常文章。
    // 降 confidence 让它进不了高置信度召回，但内容仍在。
    injectionFlag: boolean("injection_flag").notNull().default(false),
    // 换 embedding 模型时，靠这两列识别哪些行要重算
    embeddingModel: text("embedding_model"),
    embeddingDim: integer("embedding_dim"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // M0 只建 btree。RLS 会给每个查询加 tenant_id 谓词，先过滤再精确扫描，
    // 召回率 100%。单租户超过约 2 万 chunk 后再评估 HNSW。
    index("chunks_tenant_expert_channel_idx").on(t.tenantId, t.expertId, t.channel),
    index("chunks_content_hash_idx").on(t.contentHash),
    // 重新构建某篇素材时要先删掉它已有的切片（原子重建）
    index("chunks_material_idx").on(t.materialId),
  ],
);

// ── build_jobs ───────────────────────────────────────────────
// Python 写进度，Node 读给前端轮询。
export const buildJobs = pgTable(
  "build_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    expertId: uuid("expert_id").notNull().references(() => experts.id),
    // 'queued' | 'running' | 'succeeded' | 'failed'
    // 'full' = 解析→切分→向量化→提炼；'model' = 只重新提炼七维，
    // 复用已有切片。博主会反复重新生成直到满意，每次重跑 embedding 是真金白银。
    kind: text("kind").notNull().default("full"),
    status: text("status").notNull().default("queued"),
    // 0-100
    progress: integer("progress").notNull().default(0),
    stage: text("stage"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("build_jobs_expert_idx").on(t.expertId)],
);

export const schema = {
  users, tenants, authSessions, refreshTokens, loginAttempts,
  experts, expertModelDrafts, materials, chunks, buildJobs,
};
