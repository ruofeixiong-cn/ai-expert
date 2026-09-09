-- ════════════════════════════════════════════════════════════════
-- 扩展 + 两个运行时角色
--
-- 这个文件由 docker-entrypoint-initdb.d 在【首次】创建数据卷时执行。
-- 生产环境（阿里云 RDS）没有 initdb，需要 DBA 手工执行一次：
--   psql "$DATABASE_URL_OWNER" -f infra/postgres/init/01-roles.sql
-- 并把下面的开发密码换成真实密码。
--
-- 注意：角色的【创建】在这里，角色的【授权】在 drizzle 迁移 0001 里。
-- 分开是因为授权依赖表存在，而表由迁移创建。
-- ════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  -- Node 运行时：全部业务表 DML，RLS 生效
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backend') THEN
    CREATE ROLE app_backend LOGIN PASSWORD 'backend_dev_pw';
  END IF;

  -- Python 运行时：只有 chunks/build_jobs DML + experts SELECT，RLS 生效
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_agent') THEN
    CREATE ROLE app_agent LOGIN PASSWORD 'agent_dev_pw';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_backend, app_agent;
