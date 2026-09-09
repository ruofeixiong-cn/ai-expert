"""
AI 专家平台 · agent 服务。

⚠️ 这是【内网服务】。所有路径都在 /internal 下，部署时不得暴露到公网。
   对外唯一入口是 Node backend。
"""

from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
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


class BuildRequest(BaseModel):
    """
    由 backend 调用。tenant_id 虽然来自可信内网，agent 仍会用 experts 表核对
    （见 db/session.py 的 verified_tenant_conn）—— 可信不等于不会有 bug。
    """

    expert_id: UUID
    tenant_id: UUID
    # 只构建这些素材；为空表示该专家名下全部未构建的素材
    material_ids: list[UUID] = Field(default_factory=list)


class BuildAccepted(BaseModel):
    job_id: UUID


@app.post(
    "/internal/build",
    response_model=BuildAccepted,
    status_code=202,
    tags=["build"],
    summary="入队构建任务，立即返回 job_id",
    description=(
        "进度写入 build_jobs 表，由 backend 读给前端轮询。"
        "任务失败时必须把 status 置为 failed 并写入可读的 error。"
    ),
    dependencies=[Depends(require_internal_token)],
)
async def build(req: BuildRequest) -> BuildAccepted:
    raise HTTPException(status_code=501, detail="尚未实现（M1 实现中）")


@app.get("/internal/readyz", response_model=ReadyResponse, tags=["system"],
         summary="就绪探针（检查数据库可达）",
         dependencies=[Depends(require_internal_token)])
async def readyz() -> ReadyResponse:
    return ReadyResponse(database="ok" if await ping() else "down")
