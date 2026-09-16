-- ════════════════════════════════════════════════════════════════════════════
-- 短链解析不再依赖「属主是超级用户」（B27，见 docs/adr/008）
--
-- 原来：resolve_share_slug 是 SECURITY DEFINER，属主 app_owner。
--       它能读到 experts 只是因为本地的 app_owner 恰好是超级用户 ——
--       超级用户连 FORCE ROW LEVEL SECURITY 也绕过。
--       生产上迁移账号不是超级用户 → 函数读到 0 行 → 所有分享链接 404，
--       而且接口、日志、测试都不报错。
--
-- 现在：函数属主换成 share_resolver（NOLOGIN，连不上库），
--       可见性由一条【限定角色】的策略给。
--
-- 为什么 0010 否决了策略、这里又用了策略：
--   0010 否决的是【不限定角色】的策略。permissive 策略之间是 OR 的，
--   不限定角色等于让 app_backend 在无租户上下文时读到已上线专家的整行，
--   包括 confirmed_model（博主还没上线的编辑中内容）。
--   加上 TO share_resolver 之后，这条策略只对该角色生效：
--   app_backend / app_agent 的可见性一个字节都没变。
--
-- 前置条件：share_resolver 角色已存在，且 app_owner 是它的【INHERIT FALSE】成员
--          （由 infra/postgres/init/01-roles.sql 建立）。
--          不满足时下面的 ALTER FUNCTION 会直接失败 —— 这是期望行为，fail fast。
-- ════════════════════════════════════════════════════════════════════════════

-- PG16 才有 GRANT ... WITH INHERIT FALSE 与 pg_auth_members.inherit_option。
-- 低版本上这个方案不成立，与其让后面报「列不存在」，不如在这里说清楚。
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'ADR-008 需要 PostgreSQL 16+（GRANT ... WITH INHERIT FALSE），当前是 %',
      current_setting('server_version');
  END IF;
END
$$;
--> statement-breakpoint

-- ── 1. 可见性：只对 share_resolver 生效，只放行已上线的专家 ──────────────────
GRANT SELECT ON "experts" TO share_resolver;
--> statement-breakpoint
CREATE POLICY "share_lookup" ON "experts" FOR SELECT TO share_resolver
  USING (status = 'online' AND expert_model IS NOT NULL);
--> statement-breakpoint

-- ── 2. 换属主 ───────────────────────────────────────────────────────────────
--
-- 改属主要求新属主对 schema 有 CREATE 权限，临时给、改完立刻收回：
-- share_resolver 不需要建任何东西，它只需要「是这个函数的属主」。
--
GRANT CREATE ON SCHEMA public TO share_resolver;
--> statement-breakpoint
ALTER FUNCTION resolve_share_slug(text) OWNER TO share_resolver;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM share_resolver;
--> statement-breakpoint

-- ── 3. 断言没有人【继承】share_resolver ─────────────────────────────────────
--
-- 成员资格只是为了上面那句 ALTER FUNCTION（PG 要求能 SET ROLE 到新属主），
-- 必须是 INHERIT FALSE。一旦有人以继承方式成为成员，上面那条策略就会顺着
-- 角色成员关系对它生效 —— 等于给迁移账号开了一个「无租户上下文也能读已上线专家」
-- 的口子，而 agent 的测试种子与 eval 脚本正是以 app_owner 身份连库的。
--
-- 这里只断言、不修复：能改成员资格的是高权限账号，迁移账号撤不掉别人给的授权。
-- 宁可迁移失败，也不要带着这个口子上线。
--
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(pg_get_userbyid(member), ', ') INTO bad
  FROM pg_auth_members
  WHERE roleid = 'share_resolver'::regrole AND inherit_option;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '这些角色会继承 share_resolver：% —— 策略会顺着成员关系扩散。'
      '改成 GRANT share_resolver TO <角色> WITH INHERIT FALSE（见 ADR-008）', bad;
  END IF;
END
$$;
