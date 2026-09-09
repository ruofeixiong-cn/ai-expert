-- ════════════════════════════════════════════════════════════════════════════
-- 租户隔离：RLS 策略 + 角色授权
--
-- 依据：MVP 产品文档 §9.1（隔离必须是"基础设施强制"，不是"应用层自觉"）
--       验收标准 #8（租户 A 的专家检索不到租户 B 的知识）
--
-- 前置条件：app_backend / app_agent 两个角色已存在
--          （由 infra/postgres/init/01-roles.sql 创建）
--          角色不存在时本迁移会失败 —— 这是期望行为，fail fast。
--
-- drizzle-kit 不生成 RLS 与 GRANT，本文件手写。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 启用 RLS ─────────────────────────────────────────────────────────────
--
-- ENABLE 不够，必须 FORCE：
--   ENABLE 之后，表的 owner（app_owner）依然绕过所有策略。
--   迁移和运维经常以 owner 身份连库，一旦有人用 owner 跑业务查询，
--   隔离就形同虚设。FORCE 让 owner 也受策略约束。
--
ALTER TABLE "experts"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "experts"    FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chunks"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chunks"     FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "build_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "build_jobs" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── 2. 隔离策略 ─────────────────────────────────────────────────────────────
--
-- 为什么是 NULLIF(current_setting(...), '')：
--   current_setting('app.current_tenant', true) 在【未设置】时返回 NULL，
--   但在被设置成【空串】时返回 ''，而 ''::uuid 会抛异常。
--   NULLIF 把两种情况统一成 NULL，比较结果为 NULL → 过滤掉全部行。
--
-- 为什么要 fail-closed 到"0 行"而不是报错：
--   报错会诱导开发者加 try/catch 绕过；返回 0 行则让功能直接不工作，
--   逼着人正确调用 tenantTx() / tenant_conn()。
--
-- WITH CHECK 与 USING 同时给：
--   USING 管【能看见哪些行】，WITH CHECK 管【能写入哪些行】。
--   只给 USING 的话，租户 A 可以插入 tenant_id = B 的行（写进去看不见），
--   造成脏数据且难以排查。
--
CREATE POLICY "tenant_isolation" ON "experts"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chunks"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "build_jobs"
  USING      ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint

-- ── 3. app_backend：Node 运行时 ─────────────────────────────────────────────
--
-- 全部业务表 DML。给 ALTER DEFAULT PRIVILEGES，以后新增的表自动授权 ——
-- 因为 Node 本来就是业务主体，逐张表授权只会造成"忘了授权"的运维事故。
--
GRANT USAGE ON SCHEMA public TO app_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_backend;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_backend;
--> statement-breakpoint

-- ── 4. app_agent：Python 运行时 ─────────────────────────────────────────────
--
-- 允许清单，不是拒绝清单。刻意【不给】ALTER DEFAULT PRIVILEGES：
--   以后新增的 orders / credit_ledger / messages / feedbacks 等表，
--   对 Python 默认不可达。要开口必须显式写一条 GRANT，
--   而写 GRANT 的时候人会停下来想一秒"agent 真的需要碰钱的表吗"。
--
-- 效果：Python 代码写错了、被注入了、依赖被投毒了，也碰不到 users / orders。
-- 这和 RLS 是同一个哲学 —— 权限边界由数据库强制，不靠代码自觉。
--
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_agent;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_agent;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chunks"     TO app_agent;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build_jobs" TO app_agent;
--> statement-breakpoint
-- experts 只读：Python 需要读 expert_model 和校验 tenant 归属，不需要写。
-- 七维提炼结果通过内部接口回传给 Node 落库。
GRANT SELECT ON "experts" TO app_agent;
