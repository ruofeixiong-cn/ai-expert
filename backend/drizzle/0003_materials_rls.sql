-- ════════════════════════════════════════════════════════════════════════════
-- materials 的隔离与授权
--
-- 这是【允许清单机制第一次真正用上】：0001 里刻意没给 app_agent
-- ALTER DEFAULT PRIVILEGES，所以新建的 materials 表对 Python 默认不可达。
-- 要开口必须在这里显式写一条 GRANT —— 而写的时候人会停一秒想：
-- "agent 真的需要读这张表吗？需要写吗？"
--
-- 答案：需要读（构建时取原文），不需要写（素材由 backend 落库）。
-- 所以只给 SELECT。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "materials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "materials" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "materials"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint

-- app_backend 走的是 0001 里的 ALTER DEFAULT PRIVILEGES，新表自动有 DML，
-- 这里不需要再写。（业务主体逐张表授权只会造成"忘了授权"的运维事故。）

-- app_agent：只读。写素材是 backend 的事。
GRANT SELECT ON "materials" TO app_agent;
