"""
A8：Python 侧的手写表定义不得与真实 DDL 漂移。

表结构的唯一来源是 backend/src/db/schema/index.ts。Python 这边是镜像。
镜像会过期 —— 这个测试保证它过期时 CI 会红，而不是等到运行时报
"column does not exist"。
"""

from sqlalchemy import text

from app.db.tables import MIRRORED_TABLES, metadata


async def test_no_column_drift(owner_engine):
    async with owner_engine.connect() as conn:
        for table_name in MIRRORED_TABLES:
            rows = (
                await conn.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = 'public' AND table_name = :t"
                    ),
                    {"t": table_name},
                )
            ).fetchall()
            actual = {r[0] for r in rows}
            assert actual, f"表 {table_name} 在数据库里不存在 —— 迁移没跑？"

            declared = {c.name for c in metadata.tables[table_name].columns}
            missing = declared - actual
            assert not missing, (
                f"{table_name}: Python 声明了数据库里没有的列 {sorted(missing)} —— "
                f"镜像过期了，去对照 backend/src/db/schema/index.ts 修正"
            )
