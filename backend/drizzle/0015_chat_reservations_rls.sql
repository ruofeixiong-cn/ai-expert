-- ════════════════════════════════════════════════════════════════════════════
-- chat_reservations 的隔离与授权（B02）
--
-- 预扣是试聊额度的记账数据，属于业务，不属于内容处理。
-- 允许清单照旧：agent 不需要碰它，所以一条 GRANT 都不给 ——
-- 0001 刻意没给 app_agent 默认授权，新表对 Python 默认不可达。
--
-- app_backend 走 0001 的 ALTER DEFAULT PRIVILEGES，新表自动有 DML，这里不用写。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "chat_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chat_reservations" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chat_reservations"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
