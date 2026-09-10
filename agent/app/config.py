from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    # app_agent 角色：RLS 生效，且只被 GRANT 了 chunks / build_jobs / experts
    DATABASE_URL_AGENT: str = (
        "postgresql+asyncpg://app_agent:agent_dev_pw@localhost:5432/ai_expert"
    )
    # backend → agent 的内网共享密钥。agent 永不对公网开放。
    INTERNAL_TOKEN: str = "dev_internal_token_change_me"
    AGENT_PORT: int = 8000
    REDIS_URL: str = "redis://localhost:6379/0"

    # ── 百炼 ──────────────────────────────────────────────
    DASHSCOPE_API_KEY: str = ""
    DASHSCOPE_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    MODEL_EMBEDDING: str = "text-embedding-v3"
    MODEL_CHAT: str = "qwen-plus"
    MODEL_EXTRACT: str = "qwen-max"
    MODEL_RERANK: str = "gte-rerank-v2"
    EMBEDDING_DIM: int = 1024
    # auto = 有 key 用百炼，没 key 用确定性假向量（CI / 无网开发）
    EMBEDDING_PROVIDER: str = "auto"
    # 七维提炼同理：auto = 有 key 用 qwen-max，fake = 确定性假草稿。
    # CI 不该为了跑测试去调真实 LLM —— 慢、花钱、会因限流随机失败。
    EXTRACT_PROVIDER: str = "auto"
    # 对话生成与重排序同理。三个开关分开，是因为它们可以独立切换：
    # 比如调 prompt 时想用真模型生成，但不想每次都重跑向量化。
    CHAT_PROVIDER: str = "auto"
    RERANK_PROVIDER: str = "auto"

    # ── 可观测（Langfuse）─────────────────────────────────
    # 默认关。观测组件不该有能力影响回答，也不该让测试因为它挂掉而变红。
    # 打开：docker compose --profile obs up -d && uv sync --group obs
    LANGFUSE_ENABLED: bool = False
    LANGFUSE_HOST: str = "http://localhost:3000"
    LANGFUSE_PUBLIC_KEY: str = ""
    LANGFUSE_SECRET_KEY: str = ""


settings = Settings()
