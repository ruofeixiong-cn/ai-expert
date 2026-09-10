-- ════════════════════════════════════════════════════════════════════════════
-- messages.seq —— 会话内的严格顺序
--
-- created_at 的默认值是 now()，而 now() 返回的是【事务开始时间】：
-- 同一个事务里插入的两条消息，时间戳完全相同，ORDER BY created_at 的结果
-- 是未定义的。生产上提问和回答分属两个事务（beginChat / settleChat），
-- 所以一直看起来正常 —— 这种"看起来正常"最危险：哪天有人把两条消息合到
-- 一个事务里写，聊天记录就开始乱序，而且不报任何错。
--
-- M4 写测试时撞上了（种子数据用一个事务塞一轮问答，历史顺序翻了）。
--
-- 一并修掉两处依赖时间戳比较的地方：
--   settleChat 的幂等判断（"这条提问后面有没有回答了"）
--   看板 LATERAL 取"这条回答之前最近的一条提问"
-- ════════════════════════════════════════════════════════════════════════════

DROP INDEX "messages_conversation_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint

-- ADD COLUMN 按物理顺序赋值，对已有行不保证正确。显式按时间回填 ——
-- 时间相同时 role DESC 让 'user' 排在 'assistant' 前面（提问先于回答）。
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, role DESC) AS rn FROM messages
)
UPDATE messages m SET seq = o.rn FROM ordered o WHERE m.id = o.id;--> statement-breakpoint

-- 回填改了值但没动序列，不 setval 的话下一条新消息会拿到一个偏小的 seq。
SELECT setval(
  pg_get_serial_sequence('messages', 'seq'),
  GREATEST((SELECT coalesce(max(seq), 0) FROM messages), 1)
);--> statement-breakpoint

CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","seq");
--> statement-breakpoint

-- ── 序列权限 ────────────────────────────────────────────────────────────────
--
-- seq 是全库第一个序列（在这之前所有主键都是 uuid + gen_random_uuid()），
-- 而 0001 只给了表权限。没有这两句，backend 插入 messages 会直接
-- "permission denied for sequence" —— 对话功能整个挂掉。
--
-- 只给 app_backend。agent 不写 messages（0009 只给了 SELECT），
-- 允许清单照旧：不需要就不给。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backend;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_backend;
