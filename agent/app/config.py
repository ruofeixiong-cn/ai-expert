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
    EMBEDDING_DIM: int = 1024


settings = Settings()
