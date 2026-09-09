"""
AI 专家平台 · agent 服务。

⚠️ 这是【内网服务】。所有路径都在 /internal 下，部署时不得暴露到公网。
   对外唯一入口是 Node backend。
"""

from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from app.config import settings
from app.db.session import dispose_engine, ping

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


app = FastAPI(
    lifespan=lifespan,
    title="AI 专家平台 · 内部 Agent API",
    version="0.0.1",
    description="仅供 backend 内网调用。永不对公网开放。",
)


async def require_internal_token(
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    if x_internal_token != settings.INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal token")


class HealthResponse(BaseModel):
    service: Literal["agent"] = "agent"
    status: Literal["ok"] = "ok"


class ReadyResponse(BaseModel):
    database: Literal["ok", "down"]


@app.get("/internal/health", response_model=HealthResponse, tags=["system"],
         summary="存活探针（不校验 token，供编排系统探活）")
async def health() -> HealthResponse:
    return HealthResponse()


@app.get("/internal/readyz", response_model=ReadyResponse, tags=["system"],
         summary="就绪探针（检查数据库可达）",
         dependencies=[Depends(require_internal_token)])
async def readyz() -> ReadyResponse:
    return ReadyResponse(database="ok" if await ping() else "down")
