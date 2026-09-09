-- ════════════════════════════════════════════════════════════════════════════
-- expert_model_drafts 的隔离与授权
--
-- 允许清单机制第二次使用：0001 刻意没给 app_agent ALTER DEFAULT PRIVILEGES，
-- 所以这张新表对 Python 默认不可达，必须在这里显式开口。
--
-- 开口前先问一遍边界：
--   agent 需要写草稿吗？需要 —— 七维是它提炼的。
--   agent 需要删草稿吗？不需要 —— 草稿只被下一次生成整行覆盖。
--   所以给 SELECT / INSERT / UPDATE，【不给 DELETE】。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "expert_model_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "expert_model_drafts" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "expert_model_drafts"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "expert_model_drafts" TO app_agent;
