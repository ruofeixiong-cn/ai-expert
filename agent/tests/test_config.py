"""
B05：生产环境不许用开发默认值启动。

默认值是为了本地开箱即用。部署时忘了配，服务照样起来、照样工作 ——
backend 与 agent 之间的内网密钥就成了写在仓库里的公开字符串。
这种错误不会有任何报错，所以要让它在启动那一刻就失败。
"""

import pytest

from app.config import Settings

REAL_TOKEN = "k" * 32
REAL_DB = "postgresql+asyncpg://app_agent:s3cret-from-vault@db:5432/ai_expert"


@pytest.fixture
def production(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("DATABASE_URL_AGENT", raising=False)
    return monkeypatch


def test_refuses_default_internal_token(production):
    production.setenv("DATABASE_URL_AGENT", REAL_DB)
    with pytest.raises(ValueError, match="INTERNAL_TOKEN"):
        Settings(_env_file=None)


def test_refuses_short_internal_token(production):
    production.setenv("DATABASE_URL_AGENT", REAL_DB)
    production.setenv("INTERNAL_TOKEN", "short")
    with pytest.raises(ValueError, match="INTERNAL_TOKEN"):
        Settings(_env_file=None)


def test_refuses_default_database_password(production):
    production.setenv("INTERNAL_TOKEN", REAL_TOKEN)
    with pytest.raises(ValueError, match="DATABASE_URL_AGENT"):
        Settings(_env_file=None)


def test_starts_with_real_secrets(production):
    production.setenv("INTERNAL_TOKEN", REAL_TOKEN)
    production.setenv("DATABASE_URL_AGENT", REAL_DB)
    assert Settings(_env_file=None).ENV == "production"


def test_refuses_trusted_fetch_ranges(production):
    """云主机上没有代理 fake-ip，放行任何网段都只会给 SSRF 开口子。"""
    production.setenv("INTERNAL_TOKEN", REAL_TOKEN)
    production.setenv("DATABASE_URL_AGENT", REAL_DB)
    production.setenv("FETCH_TRUSTED_CIDRS", "198.18.0.0/15")
    with pytest.raises(ValueError, match="FETCH_TRUSTED_CIDRS"):
        Settings(_env_file=None)


def test_development_keeps_defaults(monkeypatch):
    monkeypatch.delenv("NODE_ENV", raising=False)
    assert Settings(_env_file=None).ENV == "development"
