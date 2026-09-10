"""
B06：构建任务并发写乱、会永久卡住。见 docs/adr/002-build-job-concurrency.md。

  1. 连点两次「构建」，两个 job 并发「先删后插」。READ COMMITTED 下，
     第二个事务的 delete 看不到第一个刚提交的行 → 重复切片。
  2. ARQ 的超时靠 cancel 实现，CancelledError 是 BaseException，
     `except Exception` 接不住 → build_jobs 永远停在 running，前端永远在转。
"""

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import insert, select, text

from app.config import settings
from app.db.session import tenant_conn
from app.db.tables import build_jobs
from app.main import app
from app.workers import build as worker

ARTICLE = "# 定投\n\n定投的核心是纪律，不是频率。长期持有满两年通常可以免掉赎回费。\n"


@pytest.fixture
def no_redis(monkeypatch):
    """不往真实队列里塞任务 —— 残留的任务会被下一次 e2e 的 worker 捡起来跑。"""
    queued: list[tuple] = []

    class FakePool:
        async def enqueue_job(self, *args):
            queued.append(args)

        async def aclose(self):
            pass

    async def fake_create_pool(*args, **kwargs):
        return FakePool()

    monkeypatch.setattr("arq.create_pool", fake_create_pool)
    return queued


async def _fresh_expert(owner_engine, tenant_id, user_id):
    async with owner_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)})
        return (await conn.execute(
            text("INSERT INTO experts (tenant_id, owner_id, name) VALUES (:t,:u,:n) RETURNING id"),
            {"t": tenant_id, "u": user_id, "n": f"b06-{uuid4().hex[:6]}"},
        )).scalar_one()


async def _add_material(owner_engine, tenant_id, expert_id):
    async with owner_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)})
        await conn.execute(
            text("INSERT INTO materials (tenant_id, expert_id, source_type, title, raw_text, content_hash) "
                 "VALUES (:t,:e,'paste','测试',:r,:h)"),
            {"t": tenant_id, "e": expert_id, "r": ARTICLE, "h": uuid4().hex},
        )


async def _jobs(tenant_id, expert_id):
    async with tenant_conn(tenant_id) as conn:
        return (await conn.execute(
            select(build_jobs).where(build_jobs.c.expert_id == expert_id).order_by(build_jobs.c.created_at)
        )).fetchall()


async def _post(path: str, body: dict) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent") as c:
        return await c.post(path, headers={"x-internal-token": settings.INTERNAL_TOKEN}, json=body)


# ─── 并发 ────────────────────────────────────────────────────────────────────

async def test_second_build_while_one_is_active_is_refused(owner_engine, seeded, no_redis):
    a = seeded["a"]
    expert = await _fresh_expert(owner_engine, a["tenant_id"], a["user_id"])
    body = {"expert_id": str(expert), "tenant_id": str(a["tenant_id"])}

    first = await _post("/internal/build", body)
    second = await _post("/internal/build", body)

    assert first.status_code == 202
    assert second.status_code == 409
    assert "正在构建" in second.json()["detail"]
    assert len(await _jobs(a["tenant_id"], expert)) == 1
    assert len(no_redis) == 1


async def test_regenerate_while_building_is_refused_too(owner_engine, seeded, no_redis):
    """「重新生成七维」和「全量构建」写的是同一份草稿，同样不能并发。"""
    a = seeded["a"]
    expert = await _fresh_expert(owner_engine, a["tenant_id"], a["user_id"])
    body = {"expert_id": str(expert), "tenant_id": str(a["tenant_id"])}

    assert (await _post("/internal/build", body)).status_code == 202
    assert (await _post("/internal/extract-model", body)).status_code == 409


# ─── 卡死回收 ────────────────────────────────────────────────────────────────

async def test_stale_active_job_is_reclaimed_instead_of_blocking_forever(owner_engine, seeded, no_redis):
    """
    有了「同一专家只能有一个进行中的任务」这条约束，一个卡死的 running
    就会永远挡住后面所有的构建 —— 所以入队前先把长时间没有进展的任务收掉。
    """
    a = seeded["a"]
    expert = await _fresh_expert(owner_engine, a["tenant_id"], a["user_id"])
    stale_id = uuid4()
    long_ago = datetime.now(timezone.utc) - timedelta(seconds=worker.STALE_JOB_SECONDS + 60)
    async with tenant_conn(a["tenant_id"]) as conn:
        await conn.execute(insert(build_jobs).values(
            id=stale_id, tenant_id=a["tenant_id"], expert_id=expert,
            status="running", progress=40, stage="embedding", updated_at=long_ago,
        ))

    r = await _post("/internal/build", {"expert_id": str(expert), "tenant_id": str(a["tenant_id"])})

    assert r.status_code == 202
    jobs = {j.id: j for j in await _jobs(a["tenant_id"], expert)}
    assert jobs[stale_id].status == "failed"
    assert "中断" in jobs[stale_id].error


async def test_timeout_marks_the_job_failed(owner_engine, seeded, monkeypatch):
    """ARQ 的 job_timeout 通过 cancel 实现：任务里收到的是 CancelledError。"""

    class CancelledMidway:
        name = "fake"
        dim = 1024

        async def embed(self, texts):
            raise asyncio.CancelledError()

    monkeypatch.setattr(worker, "get_provider", lambda: CancelledMidway())
    a = seeded["a"]
    expert = await _fresh_expert(owner_engine, a["tenant_id"], a["user_id"])
    await _add_material(owner_engine, a["tenant_id"], expert)
    job_id = uuid4()
    async with tenant_conn(a["tenant_id"]) as conn:
        await conn.execute(insert(build_jobs).values(
            id=job_id, tenant_id=a["tenant_id"], expert_id=expert, status="queued", progress=0,
        ))

    with pytest.raises(asyncio.CancelledError):
        await worker.run_build(expert, a["tenant_id"], job_id)

    (job,) = [j for j in await _jobs(a["tenant_id"], expert) if j.id == job_id]
    assert job.status == "failed"
    assert "中断" in job.error


def test_build_jobs_are_not_retried_automatically():
    """重试一个已被回收（标记失败）的任务，会和博主新点的那一次撞上唯一索引。"""
    assert worker.WorkerSettings.max_tries == 1
