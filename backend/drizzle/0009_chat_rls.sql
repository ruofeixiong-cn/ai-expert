-- ════════════════════════════════════════════════════════════════════════════
-- conversations / messages 的隔离与授权
--
-- 允许清单第三次使用。开口前的那一秒思考：
--   agent 需要读 messages 吗？需要 —— M6 用历史对话做评测与调优。
--   agent 需要【写】messages 吗？不需要 —— 落库是 backend 的事，
--     agent 只在 SSE 的 done 事件里把元数据回传给它。
--   agent 需要碰 conversations 吗？不需要。会话归属是业务，不是内容处理。
--
-- 所以：messages 只给 SELECT，conversations 一点都不给。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT ON "messages" TO app_agent;
