import os
import time
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# 种子数据必须以 app_owner 身份写（app_agent 只能碰 chunks/build_jobs）
OWNER_URL = os.environ.get(
    "DATABASE_URL_OWNER_ASYNC",
    "postgresql+asyncpg://app_owner:owner_dev_pw@localhost:5432/ai_expert",
)


@pytest_asyncio.fixture(scope="session")
async def owner_engine():
    engine = create_async_engine(OWNER_URL)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        # 安全测试不允许跳过 —— 跳过会让 CI 变绿，制造"隔离已验证"的错觉
        pytest.fail(f"数据库不可达。请先 `make up && make migrate`。\n{exc}")
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture(scope="session")
async def seeded(owner_engine):
    """建两个租户，各一个专家 + 一条 chunk。返回 (tenant_id, chunk_id) 两组。"""
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    out = {}
    async with owner_engine.begin() as conn:
        user_id = (
            await conn.execute(
                text("INSERT INTO users (role, nickname) VALUES ('creator', :n) RETURNING id"),
                {"n": f"seed_{suffix}"},
            )
        ).scalar_one()

        for key in ("a", "b"):
            name = f"tenant_{key}_{suffix}"
            tenant_id = (
                await conn.execute(
                    text("INSERT INTO tenants (owner_user_id, name) VALUES (:u, :n) RETURNING id"),
                    {"u": user_id, "n": name},
                )
            ).scalar_one()
            # experts / chunks 有 RLS 且 FORCE，owner 播种同样要设租户
            await conn.execute(
                text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)}
            )
            expert_id = (
                await conn.execute(
                    text(
                        "INSERT INTO experts (tenant_id, owner_id, name) "
                        "VALUES (:t, :u, :n) RETURNING id"
                    ),
                    {"t": tenant_id, "u": user_id, "n": name},
                )
            ).scalar_one()
            chunk_id = (
                await conn.execute(
                    text(
                        "INSERT INTO chunks (tenant_id, expert_id, channel, content) "
                        "VALUES (:t, :e, 'knowledge', :c) RETURNING id"
                    ),
                    {"t": tenant_id, "e": expert_id, "c": f"secret of {name}"},
                )
            ).scalar_one()
            out[key] = {"tenant_id": tenant_id, "expert_id": expert_id, "chunk_id": chunk_id}
    return out


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _dispose_agent_engine():
    """agent 侧的 engine 是模块级全局，测试结束要显式释放。"""
    yield
    from app.db.session import dispose_engine

    await dispose_engine()
