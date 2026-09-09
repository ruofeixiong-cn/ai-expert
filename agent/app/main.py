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


class ExtractRequest(BaseModel):
    """paste 不走这里 —— 已经是文本了，backend 直接用，省一次网络往返。"""

    source_type: Literal["file", "url"]
    url: str | None = None
    filename: str | None = None
    content_base64: str | None = None


class ExtractResponse(BaseModel):
    title: str | None
    text: str
    char_count: int


@app.post(
    "/internal/extract",
    response_model=ExtractResponse,
    tags=["ingest"],
    summary="把链接或文件提取成纯文本（同步）",
    description=(
        "同步而非入队：抓不到链接、解析不了文件应该在博主点上传的那一刻就告诉他，"
        "让他改用粘贴正文。失败时返回 422 且 detail 是可直接展示给用户的中文原因。"
    ),
    dependencies=[Depends(require_internal_token)],
)
async def extract_content(req: ExtractRequest) -> ExtractResponse:
    from app.pipeline import extract as ex

    try:
        if req.source_type == "url":
            if not req.url:
                raise HTTPException(status_code=400, detail="缺少 url")
            result = await ex.from_url(req.url)
        else:
            if not req.filename or not req.content_base64:
                raise HTTPException(status_code=400, detail="缺少 filename 或 content_base64")
            result = ex.from_file(req.filename, req.content_base64)
    except ex.ExtractError as exc:
        # 422 而不是 500：这不是服务故障，是这份素材提取不了，用户换个方式就行
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ExtractResponse(
        title=result.title, text=result.text, char_count=len(result.text)
    )


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
    from uuid import uuid4

    from arq import create_pool
    from arq.connections import RedisSettings
    from sqlalchemy import insert

    from app.db.session import verified_tenant_conn
    from app.db.tables import build_jobs

    # backend 是可信内网调用方，但"可信"不等于"不会有 bug"。
    # 这里再用 experts 表核对一次 expert 是否真属于该租户。
    try:
        async with verified_tenant_conn(req.expert_id, req.tenant_id) as conn:
            job_id = uuid4()
            await conn.execute(
                insert(build_jobs).values(
                    id=job_id,
                    tenant_id=req.tenant_id,
                    expert_id=req.expert_id,
                    status="queued",
                    progress=0,
                    stage="queued",
                )
            )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    pool = await create_pool(RedisSettings.from_dsn(settings.REDIS_URL))
    try:
        await pool.enqueue_job(
            "build_expert",
            str(req.expert_id),
            str(req.tenant_id),
            str(job_id),
            [str(m) for m in req.material_ids] or None,
        )
    finally:
        await pool.aclose()

    return BuildAccepted(job_id=job_id)


@app.get("/internal/readyz", response_model=ReadyResponse, tags=["system"],
         summary="就绪探针（检查数据库可达）",
         dependencies=[Depends(require_internal_token)])
async def readyz() -> ReadyResponse:
    return ReadyResponse(database="ok" if await ping() else "down")
