-- ════════════════════════════════════════════════════════════════
-- 扩展 + 角色
--
-- 这个文件由 docker-entrypoint-initdb.d 在【首次】创建数据卷时执行，
-- 身份是 docker 的 POSTGRES_USER（超级用户 postgres）。
--
-- 生产环境（阿里云 RDS）没有 initdb，需要 DBA 用【高权限账号】手工执行一次：
--   psql "$DATABASE_URL_ADMIN" -f infra/postgres/init/01-roles.sql
-- 并把下面的开发密码换成真实密码。
--
-- 注意：角色的【创建】在这里，角色的【授权】在 drizzle 迁移里。
-- 分开是因为授权依赖表存在，而表由迁移创建。
--
-- ⚠️ app_owner 必须是【普通角色】，不能是超级用户 —— 见 docs/adr/008。
--    本地曾经用 app_owner 当 POSTGRES_USER，于是它是超级用户，
--    连 FORCE ROW LEVEL SECURITY 都能绕过；一整类「靠 owner 特权才跑得通」的代码
--    在本地永远是绿的，到了生产才暴露（B27：分享链接全部 404）。
--    本地权限形状必须和生产一样，测试才有意义。
-- ════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  -- 迁移角色：拥有库与 schema 的属主权，可以跑 DDL，但【不能绕过 RLS】。
  -- 生产环境这个角色通常已经存在（就是 RDS 给应用的那个账号），这里不会重建。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner LOGIN PASSWORD 'owner_dev_pw';
  END IF;

  -- Node 运行时：全部业务表 DML，RLS 生效
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backend') THEN
    CREATE ROLE app_backend LOGIN PASSWORD 'backend_dev_pw';
  END IF;

  -- Python 运行时：只有 chunks/build_jobs DML + experts SELECT，RLS 生效
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_agent') THEN
    CREATE ROLE app_agent LOGIN PASSWORD 'agent_dev_pw';
  END IF;

  -- 短链解析函数的属主（ADR-008）。NOLOGIN、无密码：谁也连不上它，
  -- 它只在 resolve_share_slug 的函数体内短暂成为 current_user。
  -- 刻意【不给】BYPASSRLS：那需要超级用户，托管 RDS 上通常做不到，
  -- 而且一个常驻的能看穿全库的角色本身就是风险面。可见性由一条限定角色的策略给，
  -- 授权写在迁移 0017 里。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'share_resolver') THEN
    CREATE ROLE share_resolver NOLOGIN;
  END IF;
END
$$;

-- 把库与 schema 的属主权交给 app_owner，让它能跑迁移 ——
-- 这是「普通角色也能做 DDL」的正道，不需要超级用户。
-- 只在以超级用户身份执行时才做（本地 docker 初始化）；
-- 生产上 app_owner 本来就是属主，这一段是 no-op。
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER DATABASE %I OWNER TO app_owner', current_database());
    EXECUTE 'ALTER SCHEMA public OWNER TO app_owner';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_backend, app_agent;

-- app_owner 要在迁移 0017 里把 resolve_share_slug 的属主改成 share_resolver，
-- 而 PG 要求「能 SET ROLE 到新属主」才允许改属主 —— 所以先给成员资格。
--
-- ⚠️ INHERIT FALSE 是这句话的重点，不是可选项（需要 PG16+）：
--   默认的成员资格会让 0017 那条策略【顺着角色成员关系对 app_owner 也生效】，
--   等于给迁移账号开了一个「无租户上下文也能读已上线专家」的口子 ——
--   而 agent 的测试种子与 eval 脚本正是以 app_owner 身份连库的。
--   INHERIT FALSE 之后：app_owner 读 experts 照样 0 行，但仍然能 SET ROLE
--   到 share_resolver 去改属主。两者兼得。
--   （先前试过「用完就 REVOKE」，不成立：授予者是这里的高权限账号，
--     app_owner 撤不掉别人授予的成员资格。）
GRANT share_resolver TO app_owner WITH INHERIT FALSE;
