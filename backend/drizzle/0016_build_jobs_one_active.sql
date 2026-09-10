-- ════════════════════════════════════════════════════════════════════════════
-- 同一个专家同时最多一个进行中的构建任务（B06，见 docs/adr/002）
--
-- 建索引之前先收掉历史遗留的「重复的进行中任务」，否则建索引直接失败：
-- 每个专家只保留最新的那个，其余标记为失败。
--
-- ⚠️ 生产环境：build_jobs 开了 FORCE RLS。迁移角色如果不是超级用户，
--    这条 UPDATE 在没有租户上下文时影响 0 行；那时若仍有重复，下面建索引会失败 ——
--    这是期望行为（fail fast），需要人工按租户清理。见回顾文档的 B27。
-- ════════════════════════════════════════════════════════════════════════════

UPDATE "build_jobs" AS j
SET status = 'failed',
    progress = 0,
    stage = NULL,
    error = '构建超时或被中断，请重新构建。',
    updated_at = now()
WHERE j.status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM "build_jobs" AS newer
    WHERE newer.expert_id = j.expert_id
      AND newer.status IN ('queued', 'running')
      AND (newer.created_at, newer.id) > (j.created_at, j.id)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "build_jobs_one_active_per_expert" ON "build_jobs" USING btree ("expert_id") WHERE status in ('queued', 'running');