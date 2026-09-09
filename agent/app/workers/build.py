"""
构建流水线：素材 → 清洗 → 切分 → 向量化 → chunks。

run_build 是一个纯 async 函数，不依赖 ARQ ——
测试可以直接调它，不必起 worker 进程。ARQ 只是它的调度外壳。
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import delete, insert, select, update

from app.config import settings
from app.db.session import tenant_conn
from app.db.tables import build_jobs, chunks, materials
from app.pipeline.chunk import split
from app.pipeline.clean import detect_injection, sanitize
from app.pipeline.config import MAX_CHUNKS_PER_BUILD
from app.pipeline.embed import get_provider

log = logging.getLogger(__name__)

# 命中注入特征的切片降到这个置信度。M3 的 Confidence Check 会把它挡在召回之外，
# 但内容仍在库里 —— 博主可能就是在写《如何防范提示词注入》。
INJECTED_CONFIDENCE = 0.2
NORMAL_CONFIDENCE = 1.0


class BuildError(Exception):
    """可以直接展示给博主的失败原因。"""


async def _progress(
    tenant_id: UUID, job_id: UUID, *, status: str, progress: int, stage: str | None, error: str | None = None
) -> None:
    """
    每个阶段单独一个短事务提交 —— 进度必须【立刻】可见，
    否则前端轮询到的永远是 0，直到整个任务结束才跳到 100。
    """
    async with tenant_conn(tenant_id) as conn:
        await conn.execute(
            update(build_jobs)
            .where(build_jobs.c.id == job_id)
            .values(status=status, progress=progress, stage=stage, error=error, updated_at=__import__("sqlalchemy").func.now())
        )


async def run_build(
    expert_id: UUID, tenant_id: UUID, job_id: UUID, material_ids: list[UUID] | None = None
) -> int:
    """返回写入的 chunk 数。失败时把可读原因写进 build_jobs.error 再抛出。"""
    try:
        await _progress(tenant_id, job_id, status="running", progress=5, stage="parsing")

        # ── 1. 读素材（app_agent 对 materials 只有 SELECT）──
        async with tenant_conn(tenant_id) as conn:
            stmt = select(
                materials.c.id, materials.c.title, materials.c.raw_text
            ).where(materials.c.expert_id == expert_id)
            if material_ids:
                stmt = stmt.where(materials.c.id.in_(material_ids))
            rows = (await conn.execute(stmt)).fetchall()

        if not rows:
            raise BuildError("这个专家还没有任何素材，请先上传内容。")

        # ── 2. 清洗 + 切分 ──
        await _progress(tenant_id, job_id, status="running", progress=20, stage="chunking")
        pending: list[tuple[UUID, str, bool]] = []  # (material_id, content, injected)
        for mid, title, raw in rows:
            text = sanitize(raw)
            for ch in split(title, text):
                pending.append((mid, ch.content, detect_injection(ch.content)))

        if not pending:
            raise BuildError("素材里没有可用的文字内容。")
        if len(pending) > MAX_CHUNKS_PER_BUILD:
            raise BuildError(
                f"这批素材会产生 {len(pending)} 个知识切片，超过单次上限 "
                f"{MAX_CHUNKS_PER_BUILD}。请分批构建。"
            )

        # ── 3. 向量化 ──
        # 全部先算完再写库：这样供应商报错时【一条 chunk 都不会落地】，
        # 不会留下半截数据。也避免把一个跨越几分钟 API 调用的长事务挂在库上。
        await _progress(tenant_id, job_id, status="running", progress=40, stage="embedding")
        provider = get_provider()
        try:
            vectors = await provider.embed([c for _, c, _ in pending])
        except Exception as exc:  # noqa: BLE001
            log.exception("embedding 失败 expert=%s", expert_id)
            raise BuildError(f"向量化服务调用失败：{type(exc).__name__}。请稍后重试。") from exc

        if len(vectors) != len(pending):
            raise BuildError("向量化返回数量与切片数量不一致，已中止以免数据错位。")

        # ── 4. 原子写入 ──
        # 先删这批素材已有的切片再插入，全在一个事务里 ——
        # 否则重新构建会产生重复切片，而且中途失败会留下新旧混杂的数据。
        await _progress(tenant_id, job_id, status="running", progress=85, stage="embedding")
        touched = [mid for mid, _, _ in pending]
        async with tenant_conn(tenant_id) as conn:
            await conn.execute(delete(chunks).where(chunks.c.material_id.in_(set(touched))))
            await conn.execute(
                insert(chunks),
                [
                    {
                        "tenant_id": tenant_id,
                        "expert_id": expert_id,
                        "material_id": mid,
                        "channel": "knowledge",  # 四路分流是 M2 的事，M1 全走 knowledge
                        "content": content,
                        "embedding": vec,
                        "source": "creator",
                        "confidence": INJECTED_CONFIDENCE if injected else NORMAL_CONFIDENCE,
                        "injection_flag": injected,
                        "embedding_model": (
                            settings.MODEL_EMBEDDING if provider.name == "dashscope" else "fake"
                        ),
                        "embedding_dim": provider.dim,
                    }
                    for (mid, content, injected), vec in zip(pending, vectors)
                ],
            )

        await _progress(tenant_id, job_id, status="succeeded", progress=100, stage="done")
        return len(pending)

    except BuildError as exc:
        await _progress(
            tenant_id, job_id, status="failed", progress=0, stage=None, error=str(exc)
        )
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("构建失败 expert=%s job=%s", expert_id, job_id)
        await _progress(
            tenant_id, job_id, status="failed", progress=0, stage=None,
            error="构建过程中出现意外错误，请重试或联系支持。",
        )
        raise


# ─── ARQ 外壳 ──────────────────────────────────────────────────────────────

async def build_expert(ctx: dict, expert_id: str, tenant_id: str, job_id: str,
                       material_ids: list[str] | None = None) -> int:
    return await run_build(
        UUID(expert_id), UUID(tenant_id), UUID(job_id),
        [UUID(m) for m in material_ids] if material_ids else None,
    )


class WorkerSettings:
    from arq.connections import RedisSettings

    functions = [build_expert]
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    max_jobs = 4
    job_timeout = 900
