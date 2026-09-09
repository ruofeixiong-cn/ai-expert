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

// ── experts ──────────────────────────────────────────────────
export const experts = pgTable(
  "experts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    // 七维专家模型。每个条目形如
    //   { content, confidence, evidence_chunk_ids: [] }
    // evidence_chunk_ids 为空 = AI 脑补，前端标红（防过度推断）。
    expertModel: jsonb("expert_model"),
    // 'building' | 'online' | 'offline'
    status: text("status").notNull().default("building"),
    priceCents: integer("price_cents").notNull().default(0),
    shareSlug: text("share_slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("experts_share_slug_key").on(t.shareSlug),
    index("experts_tenant_idx").on(t.tenantId),
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
    // 四路召回：'knowledge' | 'belief' | 'methodology' | 'decision' | 'example'
    channel: text("channel").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    // 'creator' | 'user_input' | 'external' | 'platform'
    // 拼 prompt 时显式标注来源，是防注入 4 条里的第 3 条
    source: text("source").notNull().default("creator"),
    confidence: doublePrecision("confidence"),
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

export const schema = { users, tenants, experts, chunks, buildJobs };
