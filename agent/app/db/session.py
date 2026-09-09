"""
⚠️ 这是全 agent 服务【唯一】允许打开数据库连接的文件。
   `make lint-db-access` 会拒绝在别处出现 engine.begin( / engine.connect(。

   原因：租户隔离依赖每个事务里正确设置 app.current_tenant。
   只要有一处绕开 tenant_conn()，RLS 就失去意义。
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.config import settings

_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    """惰性初始化 —— import 本模块不应触发建连接（openapi 导出脚本要用）。"""
    global _engine
    if _engine is None:
        _engine = create_async_engine(settings.DATABASE_URL_AGENT, pool_size=5, max_overflow=5)
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


@asynccontextmanager
async def tenant_conn(tenant_id: UUID | str) -> AsyncIterator[AsyncConnection]:
    """
    在租户上下文中打开连接。所有 chunks / build_jobs 的读写都必须走这里。

    关键实现细节 —— 为什么是 set_config 而不是 SET LOCAL：
      `SET LOCAL app.current_tenant = :t` 是非法 SQL：SET 语句不接受绑定参数，
      驱动会直接报错。set_config(name, value, is_local) 的第三个参数 true
      等价于 SET LOCAL，且能安全传参（不需要字符串拼接，也就没有注入面）。

    为什么必须在事务里（engine.begin 而不是 engine.connect）：
      is_local=True 的设置在事务结束时自动回滚。若用 SET（非 LOCAL），
      租户会粘在连接上，连接归还池子后被下一个请求复用 → 跨租户泄露。
      这是整套隔离方案唯一的致命坑。
    """
    async with get_engine().begin() as conn:
        await conn.execute(
            text("SELECT set_config('app.current_tenant', :tenant, true)"),
            {"tenant": str(tenant_id)},
        )
        yield conn


@asynccontextmanager
async def verified_tenant_conn(expert_id: UUID | str, claimed_tenant_id: UUID | str) -> AsyncIterator[AsyncConnection]:
    """
    纵深防御版本：backend 传来的 tenant_id 不直接采信，先用 experts 表核对。

    backend 是可信的内网调用方，但"可信"不等于"不会出 bug"。
    多一次 SELECT 的代价，换的是"即使 backend 传错租户，也读不到别人的数据"。
    """
    async with get_engine().begin() as conn:
        # experts 也有 RLS，所以先设置成 claimed 租户再查；
        # 若 expert 不属于该租户，这里查不到 → 直接拒绝。
        await conn.execute(
            text("SELECT set_config('app.current_tenant', :tenant, true)"),
            {"tenant": str(claimed_tenant_id)},
        )
        row = (
            await conn.execute(
                text("SELECT tenant_id FROM experts WHERE id = :eid"), {"eid": str(expert_id)}
            )
        ).first()
        if row is None:
            raise PermissionError(
                f"expert {expert_id} 不属于租户 {claimed_tenant_id}（或不存在）"
            )
        yield conn


async def ping() -> bool:
    """探活。不涉及租户数据，但依然收在本文件里 —— 唯一入口规则不留例外。"""
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
