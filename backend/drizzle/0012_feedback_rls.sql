-- ════════════════════════════════════════════════════════════════════════════
-- feedbacks 的隔离与授权
--
-- 允许清单第四次使用。开口前的那一秒思考：
--   agent 需要读 feedbacks 吗？现在不需要 —— 反馈是业务数据，不是内容处理。
--     M6 评测将来若要用负反馈做黄金问答集，那天再单独 GRANT SELECT，
--     并在 ADR 里记一笔。
--   agent 需要写吗？永远不需要。
--
-- 所以：一点权限都不给。app_agent 没有 ALTER DEFAULT PRIVILEGES，
-- 这张新表默认对 Python 不可达，什么都不写就是对的。
--
-- ⚠️ RLS 保证「A 租户的粉丝碰不到 B 租户的消息」，它保证不了
--    「张三不能给李四的对话打分」—— 两人可能在同一个租户下，策略看不出区别。
--    归属校验必须显式写在应用层（services/feedback.ts 的 join）。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "feedbacks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "feedbacks" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "feedbacks"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
