"""
M0 核心测试（Python 侧）：验收标准 #8。

Node 侧有一份等价的测试。两份都要有 —— 隔离是由【每个连库的进程】各自
正确设置租户来保证的，只测一侧等于只验证了一半。
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError

from app.db.session import get_engine, tenant_conn, verified_tenant_conn


# A4
async def test_cross_tenant_chunk_invisible(seeded):
    a, b = seeded["a"], seeded["b"]

    async with tenant_conn(a["tenant_id"]) as conn:
        own = (await conn.execute(
            text("SELECT id FROM chunks WHERE id = :c"), {"c": a["chunk_id"]})).fetchall()
        assert len(own) == 1

        other = (await conn.execute(
            text("SELECT id FROM chunks WHERE id = :c"), {"c": b["chunk_id"]})).fetchall()
        assert other == [], "租户 A 读到了租户 B 的 chunk —— RLS 失效"


async def test_full_scan_only_sees_own_tenant(seeded):
    a = seeded["a"]
    async with tenant_conn(a["tenant_id"]) as conn:
        rows = (await conn.execute(text("SELECT tenant_id FROM chunks"))).fetchall()
    assert all(r[0] == a["tenant_id"] for r in rows)


# A5：fail-closed
async def test_missing_tenant_setting_returns_zero_rows():
    async with get_engine().begin() as conn:          # 故意不设 app.current_tenant
        rows = (await conn.execute(text("SELECT id FROM chunks"))).fetchall()
    assert rows == [], "未设置租户时应返回 0 行（fail-closed），而不是全表可见"


async def test_empty_tenant_setting_returns_zero_rows():
    """空串必须和未设置等价 —— 否则 ''::uuid 会抛错，策略就变成了'报错'而非'过滤'。"""
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.current_tenant', '', true)"))
        rows = (await conn.execute(text("SELECT id FROM chunks"))).fetchall()
    assert rows == []


# A7：WITH CHECK
async def test_cross_tenant_write_rejected(seeded):
    a, b = seeded["a"], seeded["b"]
    with pytest.raises(DBAPIError):
        async with tenant_conn(a["tenant_id"]) as conn:
            await conn.execute(
                text(
                    "INSERT INTO chunks (tenant_id, expert_id, channel, content) "
                    "VALUES (:t, :e, 'knowledge', 'cross-tenant write')"
                ),
                {"t": b["tenant_id"], "e": a["expert_id"]},
            )


# A6：权限允许清单
@pytest.mark.parametrize("table", ["users", "tenants"])
async def test_agent_role_cannot_touch_business_tables(table):
    """
    app_agent 没有被 GRANT 这些表。即使 Python 代码写错、被注入、依赖被投毒，
    也碰不到用户和租户表 —— 边界由数据库强制，不靠代码自觉。
    """
    with pytest.raises((ProgrammingError, DBAPIError)) as exc:
        async with get_engine().begin() as conn:
            await conn.execute(text(f"SELECT * FROM {table} LIMIT 1"))
    assert "permission denied" in str(exc.value).lower()


async def test_agent_role_cannot_write_experts(seeded):
    """experts 只 GRANT 了 SELECT：七维结果要回传 Node 落库，不能直写。"""
    a = seeded["a"]
    with pytest.raises((ProgrammingError, DBAPIError)) as exc:
        async with tenant_conn(a["tenant_id"]) as conn:
            await conn.execute(
                text("UPDATE experts SET name = 'hacked' WHERE id = :e"), {"e": a["expert_id"]})
    assert "permission denied" in str(exc.value).lower()


# 纵深防御
async def test_verified_conn_rejects_mismatched_tenant(seeded):
    """backend 传错租户时，agent 侧自己也要挡住。"""
    a, b = seeded["a"], seeded["b"]
    with pytest.raises(PermissionError):
        async with verified_tenant_conn(a["expert_id"], b["tenant_id"]):
            pass


async def test_verified_conn_accepts_matching_tenant(seeded):
    a = seeded["a"]
    async with verified_tenant_conn(a["expert_id"], a["tenant_id"]) as conn:
        rows = (await conn.execute(text("SELECT id FROM chunks"))).fetchall()
    assert len(rows) >= 1
