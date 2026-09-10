"""
构建流水线：素材 → 清洗 → 切分 → 向量化 → chunks。

run_build 是一个纯 async 函数，不依赖 ARQ ——
测试可以直接调它，不必起 worker 进程。ARQ 只是它的调度外壳。
"""

from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import settings
from app.db.session import tenant_conn
from app.db.tables import build_jobs, chunks, expert_model_drafts, experts, materials
from app.pipeline.chunk import split
from app.pipeline.clean import detect_injection, sanitize
from app.pipeline.config import MAX_CHUNKS_PER_BUILD
from app.pipeline.embed import get_provider
from app.pipeline.extract_model import ExtractionError, extract
from app.pipeline.sample import pick

log = logging.getLogger(__name__)

# 命中注入特征的切片降到这个置信度。M3 的 Confidence Check 会把它挡在召回之外，
# 但内容仍在库里 —— 博主可能就是在写《如何防范提示词注入》。
INJECTED_CONFIDENCE = 0.2
NORMAL_CONFIDENCE = 1.0

# ── 并发与卡死回收（B06，见 docs/adr/002）──────────────────────────────────
ACTIVE_STATUSES = ("queued", "running")
# backend 迁移里的部分唯一索引：同一个专家同时最多一个进行中的任务
ACTIVE_JOB_INDEX = "build_jobs_one_active_per_expert"
# 多久没有进展就算卡死。**与 backend 的 STALE_BUILD_SECONDS 同源，且应当相等**，
# 比下面 WorkerSettings.job_timeout（15 分钟）宽裕
STALE_JOB_SECONDS = 20 * 60
INTERRUPTED_ERROR = "构建超时或被中断，请重新构建。"


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
            .values(status=status, progress=progress, stage=stage, error=error, updated_at=func.now())
        )


async def _mark_failed(tenant_id: UUID, job_id: UUID, error: str) -> None:
    await _progress(tenant_id, job_id, status="failed", progress=0, stage=None, error=error)


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

        # ── 5. 提炼七维（M2）──
        await _run_extraction(expert_id, tenant_id, job_id)

        await _progress(tenant_id, job_id, status="succeeded", progress=100, stage="done")
        return len(pending)

    except asyncio.CancelledError:
        # ARQ 的 job_timeout 通过 cancel 实现。CancelledError 是 BaseException，
        # 下面的 except Exception 接不住 —— 第一版因此把任务永远留在 running，
        # 前端进度条永远在转（B06）。标记失败，再原样抛出，让取消照常完成。
        log.warning("构建被取消（超时或中断）expert=%s job=%s", expert_id, job_id)
        await _mark_failed(tenant_id, job_id, INTERRUPTED_ERROR)
        raise
    except BuildError as exc:
        await _mark_failed(tenant_id, job_id, str(exc))
        raise
    except Exception:  # noqa: BLE001
        log.exception("构建失败 expert=%s job=%s", expert_id, job_id)
        await _mark_failed(tenant_id, job_id, "构建过程中出现意外错误，请重试或联系支持。")
        raise


async def _run_extraction(expert_id: UUID, tenant_id: UUID, job_id: UUID) -> int:
    """
    提炼七维草稿。返回采样到的切片数。

    ⚠️ 失败时【不清空已有草稿】（C11）：博主可能已经基于旧草稿确认了几个维度，
       一次提炼失败就把它抹掉，等于惩罚用户。旧草稿留着，错误写进 job。
    """
    await _progress(tenant_id, job_id, status="running", progress=90, stage="extracting")

    async with tenant_conn(tenant_id) as conn:
        name = (
            await conn.execute(select(experts.c.name).where(experts.c.id == expert_id))
        ).scalar_one_or_none()
        rows = (
            await conn.execute(
                select(chunks.c.id, chunks.c.material_id, chunks.c.content)
                .where(chunks.c.expert_id == expert_id)
                .order_by(chunks.c.created_at)
            )
        ).fetchall()

    if name is None:
        raise BuildError("专家不存在或不属于该租户。")

    samples = pick([(r[0], r[1], r[2]) for r in rows])
    try:
        model = await extract(name, samples)
    except ExtractionError as exc:
        raise BuildError(str(exc)) from exc

    # 整行替换：一个专家一份草稿。
    # app_agent 只有 INSERT/UPDATE（没有 DELETE），所以用 upsert 而不是先删后插。
    async with tenant_conn(tenant_id) as conn:
        stmt = pg_insert(expert_model_drafts).values(
            expert_id=expert_id, tenant_id=tenant_id, model=model,
            chunk_count=len(samples), generated_at=func.now(),
        )
        await conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[expert_model_drafts.c.expert_id],
                set_={
                    "model": stmt.excluded.model,
                    "chunk_count": stmt.excluded.chunk_count,
                    "generated_at": func.now(),
                },
            )
        )
    return len(samples)


async def run_extract_model(expert_id: UUID, tenant_id: UUID, job_id: UUID) -> int:
    """
    只重新提炼，不重新向量化（C10）。

    博主会反复重新生成七维直到满意。每次都重跑 embedding 是真金白银 ——
    切片没变，向量就没必要重算。
    """
    try:
        n = await _run_extraction(expert_id, tenant_id, job_id)
        await _progress(tenant_id, job_id, status="succeeded", progress=100, stage="done")
        return n
    except asyncio.CancelledError:
        # 同 run_build：超时取消也要把任务标记为失败（B06）
        log.warning("提炼被取消（超时或中断）expert=%s job=%s", expert_id, job_id)
        await _mark_failed(tenant_id, job_id, INTERRUPTED_ERROR)
        raise
    except BuildError as exc:
        await _mark_failed(tenant_id, job_id, str(exc))
        raise
    except Exception:  # noqa: BLE001
        log.exception("提炼失败 expert=%s job=%s", expert_id, job_id)
        await _mark_failed(tenant_id, job_id, "提炼过程中出现意外错误，请重试或联系支持。")
        raise


# ─── ARQ 外壳 ──────────────────────────────────────────────────────────────

async def build_expert(ctx: dict, expert_id: str, tenant_id: str, job_id: str,
                       material_ids: list[str] | None = None) -> int:
    return await run_build(
        UUID(expert_id), UUID(tenant_id), UUID(job_id),
        [UUID(m) for m in material_ids] if material_ids else None,
    )


async def extract_model_job(ctx: dict, expert_id: str, tenant_id: str, job_id: str) -> int:
    return await run_extract_model(UUID(expert_id), UUID(tenant_id), UUID(job_id))


class WorkerSettings:
    from arq.connections import RedisSettings

    functions = [build_expert, extract_model_job]
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    max_jobs = 4
    job_timeout = 900
    # 不自动重试（ADR-002）。重试一个已经被回收、标记为失败的任务，
    # 会和博主新点的那一次撞上唯一索引。失败就让博主自己点，错误信息是可读的。
    max_tries = 1
