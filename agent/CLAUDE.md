# agent —— 内容与模型（Python 3.12 + FastAPI + ARQ）

**内网服务。所有路径在 `/internal` 下，部署时不得暴露到公网。**
对外唯一入口是 Node backend，鉴权靠 `x-internal-token`。

## 只做这些

正文提取、切分、向量化、四路召回、rerank、Confidence Check、Safety Check、
七维提炼、流式生成。

## 绝不做

认证、扣费、支付、任何面向公网的接口。这些全在 `backend/`。

## 数据库：三条红线

1. **不写迁移。** 表结构的唯一来源是 `backend/src/db/schema/index.ts`。
   `app/db/tables.py` 只是它的手写镜像，由 `tests/test_schema_drift.py` 防漂移。
   需要新列 → 去 backend 改 schema，回来同步镜像。
2. **只能碰 `chunks`、`build_jobs`（读写）和 `experts`（只读）。**
   这不是约定，是 `app_agent` 角色的 GRANT 允许清单 —— 碰别的表会 permission denied。
   七维提炼结果通过内部接口回传给 backend 落库，不直写。
3. **只能通过 `tenant_conn()` / `verified_tenant_conn()` 开连接。**
   `app/db/session.py` 之外出现 `engine.begin(` / `engine.connect(`
   会被 `make lint-db-access` 拒绝。

设置租户只能用 `SELECT set_config('app.current_tenant', :t, true)`。
`SET LOCAL x = :t` 是非法 SQL（SET 不接受绑定参数）；`SET`（不带 LOCAL）
会把租户粘在连接上 → 跨租户泄露。

## 向量化的两个 Provider

`EMBEDDING_PROVIDER=auto`：有 `DASHSCOPE_API_KEY` 用百炼，没有则退回确定性假向量。
测试一律 `monkeypatch` 成 `fake` —— CI 不该调真实 API（会 flaky、会花钱、会随机限流）。

⚠️ **假向量没有语义**，余弦相似度只反映哈希碰撞。
   M3 的检索质量测试必须用真 Provider，不能拿假向量测召回率然后以为没问题。

实测校准数据（2026-09-09，text-embedding-v3）：
相关句余弦 0.7544，无关句 0.2961。

## 七维提炼的两个 Provider

`EXTRACT_PROVIDER=auto`：有 key 用 `qwen-max`，没有则退回确定性假草稿。
测试与 e2e 一律用 `fake` —— 接进构建流水线后，不切 fake 会让 agent 测试
从 0.3 秒变成 29 秒，还每次都花钱。

⚠️ **假草稿没有任何提炼能力**，只是把内容原样搬进各维度。
   它能验"结构对不对、证据链通不通"这类工程性质，
   但**提炼质量必须用真实 Provider 评估**。

## LLM 调用

走百炼的 OpenAI 兼容端点 + 官方 `openai` SDK，包在 `app/llm/port.py` 后面。
业务代码只依赖那个 Protocol，不直接 import SDK —— 换供应商只改一处。
模型名一律走 `settings.MODEL_*`，不硬编码。

## 不引入 agent 框架

一期是固定流水线，不是 agent（没有工具调用循环、没有规划）。
LangChain / LlamaIndex 封装的正是我们要精确控制的 prompt 组装层，
而 LlamaIndex 的 `PGVectorStore` 自管连接、插不进 `set_config`，与 RLS 直接冲突。

唯一例外：**Pydantic AI 只用在 `pipeline/extract_model.py`**（七维结构化提炼），
不许侵入检索链路。三期做决策框架层时再评估 LangGraph。

## 完成一个改动前

```
uv run pytest -q && uv run python scripts/export_openapi.py
```
