-- ════════════════════════════════════════════════════════════════════════════
-- 分享短链的解析：RLS 上唯一一个受控的口子
--
-- 问题：粉丝不属于任何租户，所以拿到 /s/{slug} 时后端不知道该设哪个
-- app.current_tenant，而 experts 表有 RLS —— 没有租户上下文就查不到任何行。
--
-- 排除掉的几个做法：
--   ✗ 给 experts 加一条 `USING (status='online')` 的策略：策略是 OR 的，
--     等于让任何在线专家的【整行】在无租户上下文时可读 ——
--     包括 confirmed_model（博主还没上线的编辑中内容），那不是公开数据。
--   ✗ 单独建一张 share_links 表：数据重复，上线/改名时要同步，迟早不一致。
--
-- 采用：一个 SECURITY DEFINER 函数，surface 收到最窄 ——
--   只接受 slug，只返回两个 uuid，且只对【已上线】的专家返回。
--   拿到 tenant_id 之后，后续查询照常走 tenantTx，RLS 全程生效。
--
-- SECURITY DEFINER 的经典陷阱是 search_path 劫持，所以显式钉死。
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION resolve_share_slug(p_slug text)
RETURNS TABLE (expert_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT id, tenant_id
  FROM experts
  WHERE share_slug = p_slug
    AND status = 'online'
    AND expert_model IS NOT NULL
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_share_slug(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_share_slug(text) TO app_backend;
