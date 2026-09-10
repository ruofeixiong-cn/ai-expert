from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_INTERNAL_TOKEN = "dev_internal_token_change_me"
_DEV_DB_PASSWORD = "agent_dev_pw"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    # 和 backend 共用同一个开关、同一份 .env：部署时只需设 NODE_ENV=production 一处
    ENV: str = Field("development", validation_alias="NODE_ENV")

    # app_agent 角色：RLS 生效，且只被 GRANT 了 chunks / build_jobs / experts
    DATABASE_URL_AGENT: str = (
        f"postgresql+asyncpg://app_agent:{_DEV_DB_PASSWORD}@localhost:5432/ai_expert"
    )
    # backend → agent 的内网共享密钥。agent 永不对公网开放。
    INTERNAL_TOKEN: str = DEFAULT_INTERNAL_TOKEN
    AGENT_PORT: int = 8000
    REDIS_URL: str = "redis://localhost:6379/0"

    # 链接抓取时额外放行的网段，逗号分隔。【只给开发用】。
    # 本机开了代理的 fake-ip 模式（Clash / Surge 等）时，所有域名都解析到 198.18.0.0/15，
    # SSRF 防护会把它们全当成保留地址拒掉 —— 本地要抓链接就填 198.18.0.0/15。
    # 生产环境设了它就拒绝启动：云主机上没有 fake-ip，放行任何网段都只会开口子。
    FETCH_TRUSTED_CIDRS: str = ""

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

    @model_validator(mode="after")
    def _refuse_dev_secrets_in_production(self) -> "Settings":
        """
        生产环境不许用开发默认值启动（B05）。

        默认值只为本地开箱即用。部署时忘了配，服务照样起来、照样工作 ——
        backend 与 agent 之间的内网密钥就成了写在仓库里的公开字符串，
        而且不会有任何报错。所以让它在启动的那一刻失败。
        """
        if self.ENV != "production":
            return self
        problems = []
        if self.INTERNAL_TOKEN == DEFAULT_INTERNAL_TOKEN or len(self.INTERNAL_TOKEN) < 24:
            problems.append("INTERNAL_TOKEN（至少 24 位随机串）")
        if _DEV_DB_PASSWORD in self.DATABASE_URL_AGENT:
            problems.append("DATABASE_URL_AGENT（仍是开发密码）")
        if self.FETCH_TRUSTED_CIDRS.strip():
            problems.append("FETCH_TRUSTED_CIDRS（只能在开发环境使用）")
        if problems:
            raise ValueError(f"生产环境仍在使用开发默认值：{'；'.join(problems)}。请在部署环境里设置真实值。")
        return self


settings = Settings()
