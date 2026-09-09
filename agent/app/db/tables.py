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
    Boolean, Column, Integer, MetaData, Table, Text, TIMESTAMP, Float, func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from pgvector.sqlalchemy import Vector

metadata = MetaData()

# 读写（GRANT SELECT/INSERT/UPDATE，【没有 DELETE】）——
# 七维草稿由 agent 提炼产出，只被下一次生成整行覆盖，不该被删。
expert_model_drafts = Table(
    "expert_model_drafts",
    metadata,
    Column("expert_id", UUID(as_uuid=True), primary_key=True),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("model", JSONB, nullable=False),
    Column("chunk_count", Integer, nullable=False, server_default="0"),
    Column("generated_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

# 只读（GRANT SELECT）—— M6 用历史对话做评测与调优。
# 写 messages 是 backend 的事：agent 只在 SSE 的 done 事件里回传元数据。
# conversations 一点权限都没给 —— 会话归属是业务，不是内容处理。
messages = Table(
    "messages",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("conversation_id", UUID(as_uuid=True), nullable=False),
    Column("role", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("chunk_ids", ARRAY(UUID(as_uuid=True)), nullable=False),
    Column("confidence", Float),
    Column("finish_reason", Text),
    Column("safety", Text),
    Column("prompt_tokens", Integer),
    Column("completion_tokens", Integer),
    Column("latency_ms", Integer),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
)

# 只读（GRANT SELECT）—— 构建时取原文。写素材是 backend 的事。
materials = Table(
    "materials",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("expert_id", UUID(as_uuid=True), nullable=False),
    # paste / file / url
    Column("source_type", Text, nullable=False),
    Column("source_url", Text),
    Column("title", Text),
    Column("raw_text", Text, nullable=False),
    Column("content_hash", Text, nullable=False),
    Column("storage_key", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
)

# 读写
chunks = Table(
    "chunks",
    metadata,
    Column("id", UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()),
    Column("tenant_id", UUID(as_uuid=True), nullable=False),
    Column("expert_id", UUID(as_uuid=True), nullable=False),
    # 溯源：这条切片出自哪篇素材（可空 —— 平台公共知识层没有对应素材）
    Column("material_id", UUID(as_uuid=True)),
    # 四路召回：knowledge / belief / methodology / decision / example
    Column("channel", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("embedding", Vector(1024)),
    # creator / user_input / external / platform —— 防注入 4 条里的来源标记
    Column("source", Text, nullable=False, server_default="creator"),
    Column("confidence", Float),
    # 命中注入特征。标记而非删除，靠降 confidence 挡在高置信度召回之外。
    Column("injection_flag", Boolean, nullable=False, server_default="false"),
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
    # 'full' = 全流程；'model' = 只重新提炼七维，复用已有切片
    Column("kind", Text, nullable=False, server_default="full"),
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
    Column("confirmed_model", JSONB),
    Column("expert_model", JSONB),
    Column("status", Text, nullable=False),
    Column("price_cents", Integer, nullable=False),
    Column("share_slug", Text),
    Column("free_trial_messages", Integer, nullable=False),
    Column("confirmed_dimensions", ARRAY(Text), nullable=False),
    Column("published_at", TIMESTAMP(timezone=True)),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False),
)

# 漂移测试用：Python 侧声称存在的表
MIRRORED_TABLES = (
    "chunks", "build_jobs", "experts", "materials", "expert_model_drafts", "messages",
)
