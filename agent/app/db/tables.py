"""
Node 侧 backend/src/db/schema/index.ts 的【手写镜像】。

为什么手写而不是反射：
  反射要在 import 时连库，会让 openapi 导出脚本和单元测试都依赖数据库。
  手写 + 漂移测试（tests/test_schema_drift.py）在 CI 里比对真实 DDL，
  既保持零依赖启动，又不会悄悄漂移。

⚠️ 这里【不定义】迁移。表结构的唯一来源是 Node 的 drizzle schema。
   需要改表结构 → 去改 backend/src/db/schema/，不要在这里加列。

⚠️ 这里【只定义】app_agent 被授权的三张表。
   users / tenants 等表即使写出来也查不了（GRANT 没给），
   不写出来是为了让边界在代码里就一目了然。
"""

from sqlalchemy import (
    Column, Integer, MetaData, String, Table, Text, TIMESTAMP, Float, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from pgvector.sqlalchemy import Vector

metadata = MetaData()

# 读写
chunks = Table(
    "chunks",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("expert_id", UUID(as_uuid=True), nullable=False),
    # 四路召回：knowledge / belief / methodology / decision / example
    Column("channel", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("embedding", Vector(1024)),
    # creator / user_input / external / platform —— 防注入 4 条里的来源标记
    Column("source", Text, nullable=False, server_default="creator"),
    Column("confidence", Float),
    Column("embedding_model", Text),
    Column("embedding_dim", Integer),
    Column("content_hash", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

# 读写
build_jobs = Table(
    "build_jobs",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("expert_id", UUID(as_uuid=True), nullable=False),
    Column("status", Text, nullable=False, server_default="queued"),
    Column("progress", Integer, nullable=False, server_default="0"),
    Column("stage", Text),
    Column("error", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

# 只读（GRANT SELECT）
experts = Table(
    "experts",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("owner_id", UUID(as_uuid=True), nullable=False),
    Column("name", Text, nullable=False),
    Column("expert_model", JSONB),
    Column("status", Text, nullable=False),
    Column("price_cents", Integer, nullable=False),
    Column("share_slug", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False),
)

# 漂移测试用：Python 侧声称存在的表
MIRRORED_TABLES = ("chunks", "build_jobs", "experts")
